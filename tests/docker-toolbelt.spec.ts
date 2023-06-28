import Dockerode from 'dockerode';
import { DockerToolbelt } from '../lib';
import { expect } from 'chai';
import { stub } from 'sinon';

describe('DockerToolbelt', function () {
	const d = new DockerToolbelt({ socketPath: '/foo/docker.sock' });

	it('instantiates a docker object with the passed options', function () {
		expect(d).to.have.property('modem');
		return expect((d.modem as any).socketPath).to.equal('/foo/docker.sock');
	});

	it('provides promisified docker functions', function () {
		stub(d.modem, 'dial').callsArgWith(1, null, [{ id: '1' }, { id: '2' }]);
		return d.listImages().then((images) => {
			(d.modem.dial as any).restore();
			return expect(images).to.deep.equal([{ id: '1' }, { id: '2' }]);
		});
	});

	it('provides promisified functions for docker images', function () {
		const img = d.getImage('nonExistentImageName1234');
		// This call is expected to throw either because there's no docker or the image doesn't exist
		// But all we care about is that it throws
		const promise = img.inspect();
		expect(promise).to.be.an.instanceOf(Promise);
		// tslint:disable-next-line: no-empty
		promise.catch(function () {});
		return expect(promise).to.throw;
	});

	it('provides promisified functions for docker containers', function () {
		const c = d.getContainer('nonExistentContainerName1234');
		// This call is expected to throw either because there's no docker or the image doesn't exist
		// But all we care about is that it throws
		const promise = c.inspect();
		expect(promise).to.be.an.instanceOf(Promise);
		// tslint:disable-next-line: no-empty
		promise.catch(function () {});
		return expect(promise).to.throw;
	});

	it('does not mutate the dockerode library', function () {
		const d2 = new Dockerode();
		expect((d2 as any).listImagesAsync).to.be.undefined;
		expect((d2.getImage('foo') as any).inspectAsync).to.be.undefined;
		return expect((d2 as any).diffPaths).to.be.undefined;
	});

	it('splits an image name into its components with getRegistryAndName', function () {
		const components = d.getRegistryAndName(
			'someregistry.com/some/repo:sometag',
		);
		expect(components).to.deep.equal({
			registry: 'someregistry.com',
			imageName: 'some/repo',
			tagName: 'sometag',
			digest: undefined,
		});
	});

	it('splits an image name into its components defaulting tag to latest with getRegistryAndName', function () {
		const components = d.getRegistryAndName('someregistry.com/some/repo');
		expect(components).to.deep.equal({
			registry: 'someregistry.com',
			imageName: 'some/repo',
			tagName: 'latest',
			digest: undefined,
		});
	});

	it('matches an image name with digest with getRegistryAndName', function () {
		const components = d.getRegistryAndName(
			'someregistry.com/some/repo@sha256:0123456789abcdef0123456789abcdef',
		);
		expect(components).to.deep.equal({
			registry: 'someregistry.com',
			imageName: 'some/repo',
			tagName: undefined,
			digest: 'sha256:0123456789abcdef0123456789abcdef',
		});
	});

	it('throws when running getRegistryAndName if the image name has an invalid digest', function () {
		expect(() =>
			d.getRegistryAndName(
				'someregistry.com/some/repo@sha256:0123456789abcdef0123456789abcdeg',
			),
		).to.throw;
	});

	it('successfully parses a list of sample docker image names', function () {
		const u = undefined;
		const testVector = [
			['busybox', [u, 'busybox', 'latest', u]],
			['localhost/busybox', ['localhost', 'busybox', 'latest', u]],
			['busybox:3', [u, 'busybox', '3', u]],
			['localhost/busybox:3', ['localhost', 'busybox', '3', u]],
			['arm/busybox:3', [u, 'arm/busybox', '3', u]],
			['arm.com/busybox:3', ['arm.com', 'busybox', '3', u]],
			['arm.com/arm/busybox:3', ['arm.com', 'arm/busybox', '3', u]],
			['arm.com:5000/arm/busybox:3', ['arm.com:5000', 'arm/busybox', '3', u]],
			['a/b/c/d:1', [u, 'a/b/c/d', '1', u]],
			['a.b/c/d:1', ['a.b', 'c/d', '1', u]],
			['a.b:1', [u, 'a.b', '1', u]],
			[
				'a/b/c/d:1@a:0123456789abcdef0123456789abcdef',
				[u, 'a/b/c/d', '1', 'a:0123456789abcdef0123456789abcdef'],
			],
			[
				'a.b/c/d:1@a:0123456789abcdef0123456789abcdef',
				['a.b', 'c/d', '1', 'a:0123456789abcdef0123456789abcdef'],
			],
			[
				'a.b@a:0123456789abcdef0123456789abcdef',
				[u, 'a.b', u, 'a:0123456789abcdef0123456789abcdef'],
			],
			['[::1]:5000/busybox', ['[::1]:5000', 'busybox', 'latest', u]],
			['[::1]:5000/busybox:3', ['[::1]:5000', 'busybox', '3', u]],
			['127.0.0.1/busybox', ['127.0.0.1', 'busybox', 'latest', u]],
			['127.0.0.1/arm/busybox', ['127.0.0.1', 'arm/busybox', 'latest', u]],
			['127.0.0.1:5000/busybox', ['127.0.0.1:5000', 'busybox', 'latest', u]],
			['127.0.0.1/busybox:3', ['127.0.0.1', 'busybox', '3', u]],
			['127.0.0.1:5000/busybox:3', ['127.0.0.1:5000', 'busybox', '3', u]],
			[
				'127.0.0.1:5000/arm/busybox:3',
				['127.0.0.1:5000', 'arm/busybox', '3', u],
			],
			[
				'eu.gcr.io/aa-bb-33/foo/bar',
				['eu.gcr.io', 'aa-bb-33/foo/bar', 'latest', u],
			],
		];
		testVector.forEach(([fullName, [registry, imageName, tagName, digest]]) => {
			const components = d.getRegistryAndName(fullName as string);
			expect(components).to.deep.equal({
				registry,
				imageName,
				tagName,
				digest,
			});
		});
	});

	it('successfully compiles a list of sample docker image names', function () {
		const u = undefined;
		const testVector = [
			['busybox:latest', [u, 'busybox', u, u]],
			['localhost/busybox:latest', ['localhost', 'busybox', u, u]],
			['busybox:3', [u, 'busybox', '3', u]],
			['localhost/busybox:3', ['localhost', 'busybox', '3', u]],
			['arm/busybox:3', [u, 'arm/busybox', '3', u]],
			['arm.com/busybox:3', ['arm.com', 'busybox', '3', u]],
			['arm.com/arm/busybox:3', ['arm.com', 'arm/busybox', '3', u]],
			['arm.com:5000/arm/busybox:3', ['arm.com:5000', 'arm/busybox', '3', u]],
			['a/b/c/d/e:1', [u, 'a/b/c/d/e', '1', u]],
			['a.b/c/d/e:1', ['a.b', 'c/d/e', '1', u]],
			['a.b:1', [u, 'a.b', '1', u]],
			[
				'a/b/c/d@a:0123456789abcdef0123456789abcdef',
				[u, 'a/b/c/d', '1', 'a:0123456789abcdef0123456789abcdef'],
			],
			[
				'a.b/c/d@a:0123456789abcdef0123456789abcdef',
				['a.b', 'c/d', '1', 'a:0123456789abcdef0123456789abcdef'],
			],
			[
				'a.b@a:0123456789abcdef0123456789abcdef',
				[u, 'a.b', u, 'a:0123456789abcdef0123456789abcdef'],
			],
			['[::1]:5000/busybox:latest', ['[::1]:5000', 'busybox', u, u]],
			['[::1]:5000/busybox:3', ['[::1]:5000', 'busybox', '3', u]],
			['127.0.0.1/busybox:latest', ['127.0.0.1', 'busybox', '', u]],
			['127.0.0.1/arm/busybox:latest', ['127.0.0.1', 'arm/busybox', '', u]],
			['127.0.0.1:5000/busybox:latest', ['127.0.0.1:5000', 'busybox', '', u]],
			['127.0.0.1/busybox:3', ['127.0.0.1', 'busybox', '3', u]],
			['127.0.0.1:5000/busybox:3', ['127.0.0.1:5000', 'busybox', '3', u]],
			[
				'127.0.0.1:5000/arm/busybox:3',
				['127.0.0.1:5000', 'arm/busybox', '3', u],
			],
			[
				'eu.gcr.io/aa-bb-33/foo/bar:latest',
				['eu.gcr.io', 'aa-bb-33/foo/bar', '', u],
			],
		];
		testVector.forEach(([expected, [registry, imageName, tagName, digest]]) => {
			const fullName = d.compileRegistryAndName({
				registry,
				imageName,
				tagName,
				digest,
			} as any);
			expect(fullName).to.equal(expected);
		});
	});
});
