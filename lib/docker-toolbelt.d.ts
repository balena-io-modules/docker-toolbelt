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
	public imageRootDir(image: string): Bluebird<string>;
	public imageRootDirMounted(image: string): Bluebird.Disposer<string>;
	public diffPaths(image: string): Bluebird<string>;
	public aufsDiffPaths(image: string): Bluebird<string>;
	public createEmptyImage(imageConfig: any): Bluebird<string>;
	public createDeltaAsync(
		src: string,
		dest: string,
		onProgress?: (args: any) => void,
	): Bluebird<void>;
	public getRegistryAndName(image: any): Bluebird<ImageNameParts>;
	public compileRegistryAndName(image: ImageNameParts): Bluebird<string>;
	public normaliseImageName(name: string): Bluebird<string>;
}

export default DockerToolbelt;
