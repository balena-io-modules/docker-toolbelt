crypto = require 'crypto'
Promise = require 'bluebird'
Docker = require 'dockerode'
semver = require 'semver'
tar = require 'tar-stream'
es = require 'event-stream'
fs = Promise.promisifyAll(require('fs'))
path = require 'path'
randomstring = require 'randomstring'
execAsync = Promise.promisify(require('child_process').exec)

Promise.promisifyAll Docker.prototype, {
	filter: (name) -> name == 'run'
	multiArgs: true
}
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

getRandomFileName = (imageId) ->
	"tmp-#{imageId.split(':')[1]}-#{randomstring.generate(8)}"

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
				if semver.lt(dockerVersion, '1.10.0', true)
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
					when 'overlay2'
						imageInfo.GraphDriver.Data.UpperDir
					when 'vfs'
						path.join(dkroot, 'vfs/dir', destId)
					when 'aufs'
						path.join(dkroot, 'aufs/diff', destId)
					else
						throw new Error("Unsupported driver: #{dockerInfo.Driver}/")
	)

EEXIST = code: 'EEXIST'
ignore = ->
MIN_PAGE_SIZE = 4096

pathPrefixRemover = (prefix) ->
	(path) ->
		slice = path.substr(prefix.length)
		# return original if path doesn't start with given prefix
		return if "#{prefix}#{slice}" == path then slice else path

overlay2MountWithDisposer = (fsRoot, target, lowers, diffDir, workDir) ->
	# If no lower, just return diff directory
	return Promise.resolve(diffDir) if !lowers

	fs.mkdirAsync(target)
	.catch EEXIST, ignore
	.then ->
		options = "lowerdir=#{lowers},upperdir=#{diffDir},workdir=#{workDir}"
		mountOpts = {}
		# Use relative paths when the mount data has exceeded the page size.
		# The mount syscall fails if the mount data cannot fit within a page and
		# relative links make the mount data much smaller.
		if options.length > MIN_PAGE_SIZE
			mountOpts.cwd = fsRoot
			makeRelative = pathPrefixRemover(path.join(fsRoot, path.sep))
			options = [
				"lowerdir=#{lowers.split(':').map(makeRelative).join(':')}"
				"upperdir=#{makeRelative(diffDir)}"
				"workdir=#{makeRelative(workDir)}"
			].join(',')
		execAsync("mount -t overlay -o '#{options}' none #{target}", mountOpts)
	.return(target)
	.disposer (target) ->
		execAsync("umount #{target}")
		.then ->
			fs.rmdirAsync(target)
		.catch (err) ->
			# We don't want to crash the node process if something failed here...
			console.error('Failed to clean up after mounting overlay2', err, err.stack)
			return

aufsMountWithDisposer = (target, layerDiffPaths) ->
	# We try to create the target directory.
	# If it exists, it's *probably* from a previous run of this same function,
	# and the mount will fail if the directory is not empty or something's already mounted there.
	fs.mkdirAsync(target)
	.catch EEXIST, ignore
	.then ->
		options = 'noxino,ro,br='
		remainingBytes = MIN_PAGE_SIZE - options.length
		layerDiffPaths = layerDiffPaths.map (path) ->
			return "#{path}=ro+wh"
		appendFromIndex = layerDiffPaths.findIndex (path) ->
			remainingBytes -= path.length + 1
			# < -1 because if this is the last entry we won't actually add the comma
			return remainingBytes < -1
		appendFromIndex = layerDiffPaths.length if appendFromIndex == -1
		appendLayerPaths = layerDiffPaths[appendFromIndex...]
		options += layerDiffPaths[...appendFromIndex].join(':')

		execAsync("mount -t aufs -o '#{options}' none #{target}")
		.then ->
			Promise.mapSeries appendLayerPaths, (path) ->
				execAsync("mount -t aufs -o 'remount,append:#{path}' none #{target}")
	.return(target)
	.disposer (target) ->
		execAsync("umount #{target}")
		.then ->
			fs.rmdirAsync(target)
		.catch (err) ->
			# We don't want to crash the node process if something failed here...
			console.error('Failed to clean up after mounting aufs', err, err.stack)
			return

# Same as imageRootDir, but provides the full mounted rootfs for AUFS and overlay2,
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
			# We add a random string to the path to avoid conflicts between several calls to this function
			if driver is 'aufs'
				@diffPaths(image).then (layerDiffPaths) ->
					mountDir = path.join(dkroot, 'aufs/mnt', getRandomFileName(imageId))
					aufsMountWithDisposer(mountDir, layerDiffPaths)
			else if driver is 'overlay2'
				rootDir = path.join(dkroot, 'overlay2')
				mountDir = path.join(rootDir, getRandomFileName(imageId))
				{ LowerDir, UpperDir, MergedDir, WorkDir } = imageInfo.GraphDriver.Data
				overlay2MountWithDisposer(rootDir, mountDir, LowerDir, UpperDir, WorkDir)
			else
				@imageRootDir(image)
	)

# Only for aufs and overlay2: get the diff paths for each layer in the image.
# Ordered from latest to parent.
Docker::diffPaths = (image) ->
	Promise.join(
		@infoAsync()
		@versionAsync().get('Version')
		@getImage(image).inspectAsync()
		(dockerInfo, dockerVersion, imageInfo) ->
			driver = dockerInfo.Driver
			if driver not in [ 'aufs', 'overlay2' ]
				throw new Error('diffPaths can only be used on aufs and overlay2')
			dkroot = dockerInfo.DockerRootDir
			imageId = imageInfo.Id
			getDiffIds(dkroot, driver, imageId)
			.then (diffIds) ->
				return diffIds if semver.lt(dockerVersion, '1.10.0', true)
				Promise.map getAllChainIds(diffIds), (layerId) ->
					getCacheId(dkroot, driver, layerId)
			.call('reverse')
			.map (layerId) ->
				switch driver
					when 'aufs'
						path.join(dkroot, 'aufs/diff', layerId)
					when 'overlay2'
						path.join(dkroot, 'overlay2', layerId, 'diff')
	)

# Deprecated
Docker::aufsDiffPaths = Docker::diffPaths

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
	[ ..., registry, imageName, tagName = 'latest' ] = match
	throw new Error('Invalid image name, expected domain.tld/repo/image format.') if not imageName
	return { registry, imageName, tagName }

# Given an object representing a docker image, in the same format as given
# by getRegistryAndName, compile it back into a docker image string, which
# can be used in Docker command etc
# Example: { registry: "registry.resinstaging.io", imageName: "resin/rpi", tagName: "1234"}
#		=> registry.resinstaging.io/resin/rpi:1234
Docker::compileRegistryAndName = Promise.method ({ registry, imageName, tagName }) ->
	registry += '/' if registry? and registry isnt ''
	tagName = 'latest' if !tagName? or tagName is ''
	return "#{registry}#{imageName}:#{tagName}"

# Normalise an image name to always have a tag, with :latest being the default
Docker::normaliseImageName = Promise.method (image) ->
	@getRegistryAndName(image).then(@compileRegistryAndName)
