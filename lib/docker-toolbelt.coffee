crypto = require 'crypto'

Promise = require 'bluebird'
Docker = require 'dockerode'
semver = require 'semver'
tar = require 'tar-stream'
es = require 'event-stream'
fs = Promise.promisifyAll(require('fs'))
path = require 'path'

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

# Gets an string `image` as input and returns a promise that
# resolves to the absolute path of the root directory for that image
Docker::imageRootDir = (image) ->
	Promise.all [
		@infoAsync()
		@versionAsync().get('Version')
		@getImage(image).inspectAsync()
	]
	.spread (dockerInfo, dockerVersion, imageInfo) ->
		dkroot = dockerInfo.DockerRootDir

		imageId = imageInfo.Id

		Promise.try ->
			if semver.lt(dockerVersion, '1.10.0')
				return imageId

			[ hashType, hash ] = imageId.split(':')

			fs.readFileAsync(path.join(dkroot, "image/#{dockerInfo.Driver}/imagedb/content", hashType, hash))
			.then(JSON.parse)
			.then (metadata) ->
				layerId = createChainId(metadata.rootfs.diff_ids)
				[ hashType, hash ] = layerId.split(':')

				cacheIdPath = path.join(dkroot, "image/#{dockerInfo.Driver}/layerdb", hashType, hash, 'cache-id')

				# Resolves with 'rootId'
				fs.readFileAsync(cacheIdPath, encoding: 'utf8')
		.then (destId) ->
			switch dockerInfo.Driver
				when 'btrfs'
					path.join(dkroot, 'btrfs/subvolumes', destId)
				when 'overlay'
					imageInfo.GraphDriver.Data.RootDir
				when 'vfs'
					path.join(dkroot, 'vfs/dir', destId)
				else
					throw new Error("Unsupported driver: #{dockerInfo.Driver}/")

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
