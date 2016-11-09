* When promisifying Docker.run, multiple arguments are returned in the callback. This is now supported with passing { multiArgs: true } to the promisifyAll function.

# 1.3.0

* Implement imageRootDirMounted and aufsDiffPaths (AUFS support)

# 1.2.1

* Improve the regex used for getRegistryAndName

# 1.2.0

* Add Docker::getRegistryAndName(image)

# 1.1.0

* Support vfs/overlay in Docker::imageRoorDir()

# 1.0.0

* Initial version
