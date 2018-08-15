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
	static imageRootDir(image: string): Bluebird<string>;
	static imageRootDirMounted(image: string): Bluebird.Disposer<string>;
	static diffPaths(image: string): Bluebird<string>;
	static aufsDiffPaths(image: string): Bluebird<string>;
	static createEmptyImage(imageConfig: any): Bluebird<string>;
	static createDeltaAsync(src: string, dest: string, onProgress?: (args: any) => void): Bluebird<void>;
	static getRegistryAndName(image: any): Bluebird<ImageNameParts>;
	static compileRegistryAndName(image: ImageNameParts): Bluebird<string>;
	static normaliseImageName(name: string): Bluebird<string>;
}

export = DockerToolbelt;