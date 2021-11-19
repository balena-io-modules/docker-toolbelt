# Docker Toolbelt

A belt full of tools for working with Docker.

Docker Toolbelt extends [dockerode](https://github.com/apocas/dockerode) with additional utilities to make working with Docker a breeze. This module also supports [balenaEngine](https://github.com/balena-os/balena-engine), notably its [delta generation feature](https://www.balena.io/engine/docs/#Container-deltas).

## Installation

Install `docker-toolbelt` by running:

```sh
$ npm install --save docker-toolbelt
```

## Usage

```js
import { DockerToolbelt } from 'docker-toolbelt'

const belt = new DockerToolbelt({
  host: '192.168.1.10',
  port: process.env.DOCKER_PORT || 2375,
	...
});

const containers = await belt.listContainers()
```

## Documentation

[![Publish Documentation](https://github.com/balena-io-modules/docker-toolbelt/actions/workflows/publish-docs.yml/badge.svg)](https://github.com/balena-io-modules/docker-toolbelt/actions/workflows/publish-docs.yml)

Visit the website for complete documentation: https://balena-io-modules.github.io/docker-toolbelt
