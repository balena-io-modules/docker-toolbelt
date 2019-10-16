import * as Bluebird from 'bluebird';
import * as Docker from 'dockerode';

declare interface ImageNameParts {
	registry: string;
	imageName: string;
	tagName: string;
	digest: string;
}

declare class DockerToolbelt extends Docker {
	constructor(opts: any);
	isBalenaEngine(): Bluebird<boolean>;
	imageRootDir(image: string): Bluebird<string>;
	imageRootDirMounted(image: string): Bluebird.Disposer<string>;
	diffPaths(image: string): Bluebird<string>;
	aufsDiffPaths(image: string): Bluebird<string>;
	createEmptyImage(imageConfig: any): Bluebird<string>;
	createDeltaAsync(
		src: string,
		dest: string,
		onProgress?: (args: any) => void,
	): Bluebird<void>;
	getRegistryAndName(image: any): Bluebird<ImageNameParts>;
	compileRegistryAndName(image: ImageNameParts): Bluebird<string>;
	normaliseImageName(name: string): Bluebird<string>;
}

export = DockerToolbelt;
