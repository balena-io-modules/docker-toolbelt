import * as crypto from 'crypto';
import { promisify } from 'util';
import Docker from 'dockerode';
import * as semver from 'balena-semver';
import * as tar from 'tar-stream';
import * as es from 'event-stream';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as randomstring from 'randomstring';
import { exec } from 'child_process';
const execAsync = promisify(exec);

const MIN_PAGE_SIZE = 4096;

export type Callback<T> = (error?: any, result?: T) => void;

export interface CreateDeltaOptions {
	src: string;
	dest: string;
}

export interface ImageNameParts {
	registry: string;
	imageName: string;
	tagName: string;
	digest: string;
}

const promiseFromCallback = <T>(
	fn: (callback: (err: any, data: T) => any) => any,
): Promise<T> => {
	return new Promise((resolve, reject) => {
		fn((err, data) => {
			if (err) {
				return reject(err);
			}
			resolve(data);
		});
	});
};

const sha256sum = (data: string): string => {
	const hash = crypto.createHash('sha256');
	hash.update(data);
	return hash.digest('hex');
};

const getDigest = (data: string): string => 'sha256:' + sha256sum(data);

// Function adapted to JavaScript from
// https://github.com/docker/docker/blob/v1.10.3/layer/layer.go#L223-L226
const createChainId = (diffIds: string[]): string =>
	createChainIdFromParent('', diffIds);

const getAllChainIds = function (diffIds: string[]): string[] {
	const chainIds = [diffIds[0]];
	for (
		let i = 0, end = diffIds.length - 1, asc = 0 <= end;
		asc ? i < end : i > end;
		asc ? i++ : i--
	) {
		chainIds.push(createChainIdFromParent(chainIds[i], [diffIds[i + 1]]));
	}
	return chainIds;
};

// Function adapted to JavaScript from
// https://github.com/docker/docker/blob/v1.10.3/layer/layer.go#L223-L226
const createChainIdFromParent = (parent: string, dgsts: string[]): string => {
	if (dgsts.length === 0) {
		return parent;
	}

	if (parent === '') {
		return createChainIdFromParent(dgsts[0], dgsts.slice(1));
	}

	// H = "H(n-1) SHA256(n)"
	const dgst = getDigest(parent + ' ' + dgsts[0]);

	return createChainIdFromParent(dgst, dgsts.slice(1));
};

const getDiffIds = async (
	dkroot: string,
	driver: string,
	imageId: string,
): Promise<string[]> => {
	const [hashType, hash] = Array.from(imageId.split(':'));
	const content = await fs.readFile(
		path.join(dkroot, `image/${driver}/imagedb/content`, hashType, hash),
	);
	return JSON.parse(content.toString()).rootfs.diff_ids;
};

const getCacheId = async function (
	dkroot: string,
	driver: string,
	layerId: string,
): Promise<string> {
	const [hashType, hash] = Array.from(layerId.split(':'));
	const cacheIdPath = path.join(
		dkroot,
		`image/${driver}/layerdb`,
		hashType,
		hash,
		'cache-id',
	);
	// Resolves with 'rootId'
	const content = await fs.readFile(cacheIdPath, { encoding: 'utf8' });
	return content.toString();
};

const getRandomFileName = (imageId: string): string =>
	`tmp-${imageId.split(':')[1]}-${randomstring.generate(8)}`;

// Check if the docker version is a release after 1.10.0, or if its one of the fun
// new non-semver versions, which we incidentally know all appeared after 1.10.0
// Docker version 1.10.0 changes the way images are stored on disk and referenced
// If the docker version supports the new "content-addressable" layer format, this function returns true
const usesContentAddressableFormat = (version: string): boolean =>
	!(semver.valid(version) && semver.lt(version, '1.10.0'));

const pathPrefixRemover =
	(prefix: string): ((value: string) => string) =>
	(value: string): string => {
		const slice = value.substr(prefix.length);
		// return original if path doesn't start with given prefix
		if (`${prefix}${slice}` === value) {
			return slice;
		} else {
			return value;
		}
	};

// This function creates an overlay2 mount using the disposer pattern,
// calling the provided function before finally cleaning up the mount
// example:
// await withOverlay2Mount('/abc', '/def', '/ghi', '/jkl', (mountDir) => {
//   // ...do something with the mount
// })
const withOverlay2Mount = async <T>(
	fsRoot: string,
	target: string,
	lowers: string,
	diffDir: string,
	workDir: string,
	fn: (mountDir: string) => T,
): Promise<T> => {
	// If no lower, just return
	if (!lowers) {
		return fn(diffDir);
	}

	try {
		await fs.mkdir(target);
	} catch (err: any) {
		if (err.code !== 'EEXIST') {
			throw err;
		}
	}

	const options = `lowerdir=${lowers},upperdir=${diffDir},workdir=${workDir}`;

	let parts: Array<string | undefined> = [];
	if (options.length < MIN_PAGE_SIZE) {
		parts = [undefined, lowers, diffDir, workDir];
	} else {
		// Use relative paths when the mount data has exceeded the page size.
		// The mount syscall fails if the mount data cannot fit within a page and
		// relative links make the mount data much smaller.
		const makeRelative = pathPrefixRemover(path.join(fsRoot, path.sep));
		const results = await Promise.all(
			lowers.split(':').map(async function (lower) {
				// Read the layer's "link" file which contains its shortened layer identifier.
				// Then replace the layer's lowerdir entry with its shortened alias.
				// See: https://docs.docker.com/engine/userguide/storagedriver/overlayfs-driver/#image-and-container-layers-on-disk
				const layerId = makeRelative(lower).replace(/\/diff$/, '');
				const linkPath = path.join(fsRoot, layerId, 'link');
				const link = await fs.readFile(linkPath);
				return path.join('l', link.toString());
			}),
		);
		parts = [
			fsRoot,
			results.join(':'),
			makeRelative(diffDir),
			makeRelative(workDir),
		];
	}

	const [mountFsRoot, mountLowers, mountDiffDir, mountWorkDir] = parts;
	const mountOptions = `lowerdir=${mountLowers},upperdir=${mountDiffDir},workdir=${mountWorkDir}`;
	await execAsync(`mount -t overlay overlay -o '${mountOptions}' ${target}`, {
		cwd: mountFsRoot,
	});

	// Execute the provided function with the target as the first argument,
	// and then finally clean up the mount
	try {
		return await fn(target);
	} finally {
		try {
			await execAsync(`umount ${target}`);
			await fs.rmdir(target);
		} catch (err: any) {
			// We don't want to crash the node process if something failed here...
			console.error(
				'Failed to clean up after mounting overlay2',
				err,
				err.stack,
			);
		}
	}
};

// This function creates an aufs mount using the disposer pattern,
// calling the provided function before finally cleaning up the mount
// example:
// await withAufsMount('/abc/def', [ '/tmp/1',/tmp/2' ], (mountDir) => {
//   // ...do something with the mount
// })
const withAufsMount = async <T>(
	target: string,
	layerDiffPaths: string[], // We try to create the target directory.
	fn: (target: string) => T,
): Promise<T> => {
	// If it exists, it's *probably* from a previous run of this same function,
	// and the mount will fail if the directory is not empty or something's already mounted there.
	try {
		await fs.mkdir(target);
	} catch (err: any) {
		if (err.code !== 'EEXIST') {
			throw err;
		}
	}

	let options = 'noxino,ro,br=';
	let remainingBytes = MIN_PAGE_SIZE - options.length;
	layerDiffPaths = layerDiffPaths.map((result: string) => `${result}=ro+wh`);
	let appendFromIndex = layerDiffPaths.findIndex(function (
		result: string | any[],
	) {
		remainingBytes -= result.length + 1;
		// < -1 because if this is the last entry we won't actually add the comma
		return remainingBytes < -1;
	});
	if (appendFromIndex === -1) {
		appendFromIndex = layerDiffPaths.length;
	}
	const appendLayerPaths = layerDiffPaths.slice(appendFromIndex);
	options += layerDiffPaths.slice(0, appendFromIndex).join(':');

	await execAsync(`mount -t aufs -o '${options}' none ${target}`);
	for (const layerPath of appendLayerPaths) {
		await execAsync(
			`mount -t aufs -o 'remount,append:${layerPath}' none ${layerPath}`,
		);
	}

	// Execute the provided function with the target as the first argument,
	// and then finally clean up the mount
	try {
		return fn(target);
	} finally {
		try {
			await execAsync(`umount ${target}`);
			await fs.rmdir(target);
		} catch (err: any) {
			// We don't want to crash the node process if something failed here...
			console.error('Failed to clean up after mounting aufs', err, err.stack);
		}
	}
};

export class DockerToolbelt extends Docker {
	// Gets an string `image` as input and returns a promise that
	// resolves to the absolute path of the root directory for that image
	//
	// Note: in aufs, the path corresponds to the directory for only
	// the specific layer's fs.
	async imageRootDir(image: string): Promise<string> {
		const [dockerInfo, { Version: dockerVersion }, imageInfo] =
			await Promise.all([
				this.info(),
				this.version(),
				this.getImage(image).inspect(),
			]);

		const dkroot = dockerInfo.DockerRootDir;

		const imageId = imageInfo.Id;

		if (!usesContentAddressableFormat(dockerVersion)) {
			return imageId;
		}

		const diffIds = await getDiffIds(dkroot, dockerInfo.Driver, imageId);
		const layerId = createChainId(diffIds);
		const destId = await getCacheId(dkroot, dockerInfo.Driver, layerId);

		switch (dockerInfo.Driver) {
			case 'btrfs':
				return path.join(dkroot, 'btrfs/subvolumes', destId);
			case 'overlay':
				// TODO: fix any typing
				return (imageInfo.GraphDriver.Data as any).RootDir;
			case 'overlay2':
				// TODO: fix any typing
				return (imageInfo.GraphDriver.Data as any).UpperDir;
			case 'vfs':
				return path.join(dkroot, 'vfs/dir', destId);
			case 'aufs':
				return path.join(dkroot, 'aufs/diff', destId);
			default:
				throw new Error(`Unsupported driver: ${dockerInfo.Driver}/`);
		}
	}

	// Same as imageRootDir, but provides the full mounted rootfs for AUFS and overlay2,
	// and has a disposer to unmount.
	async withImageRootDirMounted<T>(
		image: string,
		fn: (target: string) => T,
	): Promise<T> {
		const [dockerInfo, imageInfo] = await Promise.all([
			this.info(),
			this.getImage(image).inspect(),
		]);

		const driver = dockerInfo.Driver;
		const dkroot = dockerInfo.DockerRootDir;
		const imageId = imageInfo.Id;
		// We add a random string to the path to avoid conflicts between several calls to this function
		if (driver === 'aufs') {
			const layerDiffPaths = await this.diffPaths(image);
			const mountDir = path.join(
				dkroot,
				'aufs/mnt',
				getRandomFileName(imageId),
			);
			return withAufsMount<T>(mountDir, layerDiffPaths, fn);
		} else if (driver === 'overlay2') {
			const rootDir = path.join(dkroot, 'overlay2');
			const mountDir = path.join(rootDir, getRandomFileName(imageId));
			// TODO: fix this any typing
			const { LowerDir, UpperDir, WorkDir } = imageInfo.GraphDriver.Data as any;
			return withOverlay2Mount<T>(
				rootDir,
				mountDir,
				LowerDir,
				UpperDir,
				WorkDir,
				fn,
			);
		} else {
			const rootDir = await this.imageRootDir(image);
			return fn(rootDir);
		}
	}

	// Only for aufs and overlay2: get the diff paths for each layer in the image.
	// Ordered from latest to parent.
	async diffPaths(image: string): Promise<string[]> {
		const [dockerInfo, { Version: dockerVersion }, imageInfo] =
			await Promise.all([
				this.info(),
				this.version(),
				this.getImage(image).inspect(),
			]);

		const driver = dockerInfo.Driver;
		if (!(driver === 'aufs' || driver === 'overlay2')) {
			throw new Error('diffPaths can only be used on aufs and overlay2');
		}
		const dkroot = dockerInfo.DockerRootDir;
		const imageId = imageInfo.Id;
		const ids = await getDiffIds(dkroot, driver, imageId).then(function (
			diffIds,
		) {
			if (!usesContentAddressableFormat(dockerVersion)) {
				return diffIds;
			}
			return Promise.all(
				getAllChainIds(diffIds).map(async (layerId) =>
					getCacheId(dkroot, driver, layerId),
				),
			);
		});
		return ids.reverse().map<string>(function (layerId: string) {
			return driver === 'aufs'
				? path.join(dkroot, 'aufs/diff', layerId)
				: path.join(dkroot, 'overlay2', layerId, 'diff');
		});
	}

	// Given an image configuration it constructs a valid tar archive in the same
	// way a `docker save` would have done that contains an empty filesystem image
	// with the given configuration.
	//
	// We have to go through the `docker load` mechanism in order for docker to
	// compute the correct digests and properly load it in the content store
	//
	// It returns a promise that resolves to the new image id
	async createEmptyImage(imageConfig: any): Promise<string> {
		const manifest = [
			{
				Config: 'config.json',
				RepoTags: null,
				Layers: ['0000/layer.tar'],
			},
		];

		// Since docker versions after 1.10 use a content addressable store we have
		// to make sure we always load a uniqe image so that we end up with
		// different image IDs on which we can later apply a delta stream
		const layer = tar.pack();
		layer.entry({ name: 'seed' }, String(Date.now() + Math.random()));
		layer.finalize();

		const buf = await promiseFromCallback<string>((callback) =>
			layer.pipe(es.wait(callback)),
		);
		const now = new Date().toISOString();

		const config = {
			config: imageConfig,
			created: now,
			rootfs: {
				type: 'layers',
				diff_ids: [getDigest(buf)],
			},
		};

		const imageId = sha256sum(JSON.stringify(config));

		const layerConfig = {
			id: imageId,
			created: now,
			config: imageConfig,
		};

		const image = tar.pack();
		image.entry({ name: 'manifest.json' }, JSON.stringify(manifest));
		image.entry({ name: 'config.json' }, JSON.stringify(config));
		image.entry({ name: '0000/VERSION' }, '1.0');
		image.entry({ name: '0000/json' }, JSON.stringify(layerConfig));
		image.entry({ name: '0000/layer.tar' }, buf);

		image.finalize();

		const stream = await this.loadImage(image);
		await promiseFromCallback((callback) => stream.pipe(es.wait(callback)));
		return imageId;
	}

	/**
	 * Given a source and a destination image, invokes `/images/delta` and returns a
	 * promise to a readable stream for following progress. Can also be called with a
	 * callback as the second argument instead, similar to how Dockerode methods
	 * support both a callback and async interface.
	 *
	 * Callers can extract the delta image ID by parsing the stream like so:
	 *
	 * ```
	 * const stream = await docker.createDelta({ src, dest });
	 * const deltaId = await new Promise<string>((resolve, reject) => {
	 *   let imageId: string | undefined = null;
	 *   function onFinish(err) {
	 *     if (err != null) {
	 *       return reject(err);
	 *     }
	 *     if (imageId == null) {
	 *       return reject(new Error('failed to parse delta image ID!'));
	 *     }
	 *     resolve(imageId);
	 *   }
	 *   docker.modem.followProgress(stream, onFinish, (e: any) => {
	 *     const match = /^Created delta: (sha256:\w+)$/.exec(e.status);
	 *     if (match && imageId == null) {
	 *       imageId = match[1];
	 *     }
	 *   });
	 * });
	 * ```
	 *
	 * Deltas are currently only available with balenaEngine, but this method makes
	 * no effort to determine whether that's the case.
	 */
	async createDelta(opts: CreateDeltaOptions): Promise<NodeJS.ReadableStream>;
	createDelta(
		opts: CreateDeltaOptions,
		callback: Callback<NodeJS.ReadableStream>,
	): void;
	createDelta(
		opts: CreateDeltaOptions,
		callback?: Callback<NodeJS.ReadableStream>,
	): void | Promise<NodeJS.ReadableStream> {
		const optsf = {
			path: '/images/delta?',
			method: 'POST',
			options: opts,
			isStream: true,
			statusCodes: {
				200: true,
				404: 'no such image',
				500: 'server error',
			},
		};
		if (callback == null) {
			const modem = this.modem;
			return new modem.Promise(function (resolve, reject) {
				modem.dial(optsf, function (err, data) {
					if (err) {
						return reject(err);
					}
					resolve(data as NodeJS.ReadableStream);
				});
			});
		} else {
			this.modem.dial(optsf, function (err, data) {
				callback(err, data as NodeJS.ReadableStream);
			});
		}
	}

	// Separate string containing registry and image name into its parts.
	// Example: registry.resinstaging.io/resin/rpi
	//          { registry: "registry.resinstaging.io", imageName: "resin/rpi" }
	getRegistryAndName(image: string): ImageNameParts {
		// Matches (registry)/(repo)(optional :tag or @digest)
		// regex adapted from Docker's source code:
		// https://github.com/docker/distribution/blob/release/2.7/reference/normalize.go#L62
		// https://github.com/docker/distribution/blob/release/2.7/reference/regexp.go#L44
		const match = image.match(
			/^(?:(localhost|.*?[.:].*?)\/)?(.+?)(?::(.*?))?(?:@(.*?))?$/,
		);
		if (match == null) {
			throw new Error(`Could not parse the image: ${image}`);
		}
		const registry = match[match.length - 4];
		const imageName = match[match.length - 3];
		let tagName = match[match.length - 2];
		const digest = match[match.length - 1];
		if (digest == null && tagName == null) {
			tagName = 'latest';
		}
		const digestMatch =
			digest != null
				? digest.match(
						/^[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-f-A-F]{32,}$/,
				  )
				: undefined;
		if (!imageName || (digest && !digestMatch)) {
			throw new Error(
				'Invalid image name, expected [domain.tld/]repo/image[:tag][@digest] format',
			);
		}
		return { registry, imageName, tagName, digest };
	}

	// Given an object representing a docker image, in the same format as given
	// by getRegistryAndName, compile it back into a docker image string, which
	// can be used in Docker command etc
	// Example: { registry: "registry.resinstaging.io", imageName: "resin/rpi", tagName: "1234"}
	// 		=> registry.resinstaging.io/resin/rpi:1234
	compileRegistryAndName({
		registry = '',
		imageName,
		tagName = '',
		digest,
	}: ImageNameParts): string {
		if (registry !== '') {
			registry += '/';
		}

		if (digest == null) {
			if (tagName === '') {
				tagName = 'latest';
			}
			return `${registry}${imageName}:${tagName}`;
		} else {
			// Intentionally discard the tag when a digest exists
			return `${registry}${imageName}@${digest}`;
		}
	}

	// Normalise an image name to always have a tag, with :latest being the default
	normaliseImageName(image: string): string {
		const result = this.getRegistryAndName(image);
		return this.compileRegistryAndName(result);
	}

	async isBalenaEngine(): Promise<boolean> {
		const versionInfo = await this.version();
		const engine = (versionInfo as any)['Engine'];
		if (engine == null) {
			return false;
		}
		return ['balena', 'balaena', 'balena-engine'].includes(
			engine.toLowerCase(),
		);
	}
}
