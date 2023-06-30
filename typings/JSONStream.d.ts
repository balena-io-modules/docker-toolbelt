declare module 'JSONStream' {
	export function parse(pattern?: any): NodeJS.ReadWriteStream;
	export function stringify(flag?: false): NodeJS.ReadWriteStream;
}
