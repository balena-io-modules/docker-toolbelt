m = require 'mochainon'
Promise = require 'bluebird'
Dockerode = require 'dockerode'
DockerToolbelt = require '../lib/docker-toolbelt'

{ expect } = m.chai
{ stub } = m.sinon

describe 'DockerToolbelt', ->
	before ->
		@d = new DockerToolbelt(socketPath: '/foo/docker.sock')

	it 'instantiates a docker object with the passed options', ->
		expect(@d).to.have.property('modem')
		expect(@d.modem.socketPath).to.equal('/foo/docker.sock')

	it 'provides promisified docker functions', ->
		stub(@d.modem, 'dial').callsArgWith(1, null, [ { id: '1' }, { id: '2' }])
		@d.listImages()
		.then (images) =>
			@d.modem.dial.restore()
			expect(images).to.deep.equal([ { id: '1' }, { id: '2' }])

	it 'provides promisified functions for docker images', ->
		img = @d.getImage('nonExistentImageName1234')
		# This call is expected to throw either because there's no docker or the image doesn't exist
		# But all we care about is that it throws
		promise = img.inspect()
		expect(promise).to.be.an.instanceOf(Promise)
		promise.catch(->)
		expect(promise).to.throw

	it 'provides promisified functions for docker containers', ->
		c = @d.getContainer('nonExistentContainerName1234')
		# This call is expected to throw either because there's no docker or the image doesn't exist
		# But all we care about is that it throws
		promise = c.inspect()
		expect(promise).to.be.an.instanceOf(Promise)
		promise.catch(->)
		expect(promise).to.throw

	it 'does not mutate the dockerode library', ->
		d2 = new Dockerode()
		expect(d2.listImagesAsync).to.be.undefined
		expect(d2.getImage('foo').inspectAsync).to.be.undefined
		expect(d2.diffPaths).to.be.undefined
