crypto = require 'crypto'

Promise = require 'bluebird'
Docker = require 'dockerode'
semver = require 'semver'
tar = require 'tar-stream'
es = require 'event-stream'
fs = Promise.promisifyAll(require('fs'))
path = require 'path'
execAsync = Promise.promisify(require('child_process').exec)

Promise.promisifyAll(Docker.prototype)
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(Docker({}).getImage().constructor.prototype)
Promise.promisifyAll(Docker({}).getContainer().constructor.prototype)

module.exports = Docker

sha256sum = (data) ->
	hash = crypto.createHash('sha256')
	hash.update(data)
	return hash.digest('hex')

digest = (data) ->
	return 'sha256:' + sha256sum(data)

# Function adapted to JavaScript from
# https://github.com/docker/docker/blob/v1.10.3/layer/layer.go#L223-L226
createChainId = (diffIds) ->
	return createChainIdFromParent('', diffIds)

getAllChainIds = (diffIds) ->
	chainIds = [ diffIds[0] ]
	for i in [0...diffIds.length - 1]
		chainIds.push(createChainIdFromParent(chainIds[i], [ diffIds[i + 1] ]))
	return chainIds

# Function adapted to JavaScript from
# https://github.com/docker/docker/blob/v1.10.3/layer/layer.go#L223-L226
createChainIdFromParent = (parent, dgsts) ->
	if dgsts.length is 0
		return parent

	if parent is ''
		return createChainIdFromParent(dgsts[0], dgsts[1..])

	# H = "H(n-1) SHA256(n)"
	dgst = digest(parent + ' ' + dgsts[0])

	return createChainIdFromParent(dgst, dgsts[1..])

getDiffIds = Promise.method (dkroot, driver, imageId) ->
	[ hashType, hash ] = imageId.split(':')
	fs.readFileAsync(path.join(dkroot, "image/#{driver}/imagedb/content", hashType, hash))
	.then(JSON.parse)
	.get('rootfs').get('diff_ids')

getCacheId = Promise.method (dkroot, driver, layerId) ->
	[ hashType, hash ] = layerId.split(':')
	cacheIdPath = path.join(dkroot, "image/#{driver}/layerdb", hashType, hash, 'cache-id')
	# Resolves with 'rootId'
	fs.readFileAsync(cacheIdPath, encoding: 'utf8')

# Gets an string `image` as input and returns a promise that
# resolves to the absolute path of the root directory for that image
#
# Note: in aufs, the path corresponds to the directory for only
# the specific layer's fs.
Docker::imageRootDir = (image) ->
	Promise.join(
		@infoAsync()
		@versionAsync().get('Version')
		@getImage(image).inspectAsync()
		(dockerInfo, dockerVersion, imageInfo) ->
			dkroot = dockerInfo.DockerRootDir

			imageId = imageInfo.Id

			Promise.try ->
				if semver.lt(dockerVersion, '1.10.0')
					return imageId

				getDiffIds(dkroot, dockerInfo.Driver, imageId)
				.then (diffIds) ->
					layerId = createChainId(diffIds)
					getCacheId(dkroot, dockerInfo.Driver, layerId)
			.then (destId) ->
				switch dockerInfo.Driver
					when 'btrfs'
						path.join(dkroot, 'btrfs/subvolumes', destId)
					when 'overlay'
						imageInfo.GraphDriver.Data.RootDir
					when 'vfs'
						path.join(dkroot, 'vfs/dir', destId)
					when 'aufs'
						path.join(dkroot, 'aufs/diff', destId)
					else
						throw new Error("Unsupported driver: #{dockerInfo.Driver}/")
	)
# Same as imageRootDir, but provides the full mounted rootfs for AUFS,
# and has a disposer to unmount.
Docker::imageRootDirMounted = (image) ->
	Promise.join(
		@infoAsync()
		@versionAsync().get('Version')
		@getImage(image).inspectAsync()
		(dockerInfo, dockerVersion, imageInfo) =>
			driver = dockerInfo.Driver
			dkroot = dockerInfo.DockerRootDir
			imageId = imageInfo.Id
			return @imageRootDir(image) if driver isnt 'aufs'
			@aufsDiffPaths(image)
			.then (layerDiffPaths) ->
				branchesOption = 'br=' + layerDiffPaths.join('=ro:') + '=ro'
				rootDir = path.join(dkroot, 'aufs/mnt', 'tmp' + imageId.split(':')[1])
				fs.mkdirAsync(rootDir)
				.then ->
					execAsync("mount -t aufs -o 'noxino,ro,#{branchesOption}' none #{rootDir}")
				.return(rootDir)
				.disposer (rootDir) ->
					execAsync("umount #{rootDir}")
					.then ->
						fs.rmdirAsync(rootDir)
					.catch (err) ->
						# We don't want to crash the node process if something failed here...
						console.error('Failed to clean up after imageRootDirMounted', err, err.stack)
						return
	)

# Only for AUFS: get the diff paths for each layer in the image
# Ordered from latest to parent.
Docker::aufsDiffPaths = (image) ->
	Promise.join(
		@infoAsync()
		@versionAsync().get('Version')
		@getImage(image).inspectAsync()
		(dockerInfo, dockerVersion, imageInfo) ->
			driver = dockerInfo.Driver
			throw new Error('aufsDiffPaths can only be used on aufs') if driver isnt 'aufs'
			dkroot = dockerInfo.DockerRootDir
			imageId = imageInfo.Id
			getDiffIds(dkroot, driver, imageId)
			.then (diffIds) ->
				return diffIds if semver.lt(dockerVersion, '1.10.0')
				Promise.map getAllChainIds(diffIds), (layerId) ->
					getCacheId(dkroot, driver, layerId)
			.map (layerId) ->
				path.join(dkroot, 'aufs/diff', layerId)
			.call('reverse')
	)

# Given an image configuration it constructs a valid tar archive in the same
# way a `docker save` would have done that contains an empty filesystem image
# with the given configuration.
#
# We have to go through the `docker load` mechanism in order for docker to
# compute the correct digests and properly load it in the content store
#
# It returns a promise that resolves to the new image id
Docker::createEmptyImage = (imageConfig) ->
	manifest = [
		{
			Config: 'config.json'
			RepoTags: null
			Layers: [ '0000/layer.tar' ]
		}
	]

	# Since docker versions after 1.10 use a content addressable store we have
	# to make sure we always load a uniqe image so that we end up with
	# different image IDs on which we can later apply a delta stream
	layer = tar.pack()
	layer.entry(name: 'seed', String(Date.now() + Math.random()))
	layer.finalize()

	Promise.fromCallback (callback) ->
		layer.pipe(es.wait(callback))
	.then (buf) =>
		now = (new Date()).toISOString()

		config =
			config: imageConfig
			created: now
			rootfs:
				type: 'layers'
				diff_ids: [ digest(buf) ]

		imageId = sha256sum(JSON.stringify(config))

		layerConfig =
			id: imageId
			created: now
			config: imageConfig

		image = tar.pack()
		image.entry(name: 'manifest.json', JSON.stringify(manifest))
		image.entry(name: 'config.json', JSON.stringify(config))
		image.entry(name: '0000/VERSION', '1.0')
		image.entry(name: '0000/json', JSON.stringify(layerConfig))
		image.entry(name: '0000/layer.tar', buf)

		image.finalize()

		@loadImageAsync(image)
		.then (stream) ->
			Promise.fromCallback (callback) ->
				stream.pipe(es.wait(callback))
		.return(imageId)

# Separate string containing registry and image name into its parts.
# Example: registry.resinstaging.io/resin/rpi
#          { registry: "registry.resinstaging.io", imageName: "resin/rpi" }
Docker::getRegistryAndName = Promise.method (image) ->
	match = image.match(/^(?:([^\/:.]+\.[^\/:]+(?::[0-9]+)?)\/)?([^\/:]+(?:\/[^\/:]+)?)(?::(.*))?$/)
	throw new Error("Could not parse the image: #{image}") if not match?
	[ ..., registry = 'docker.io', imageName, tagName = 'latest' ] = match
	throw new Error('Invalid image name, expected domain.tld/repo/image format.') if not imageName
	return { registry, imageName, tagName }
