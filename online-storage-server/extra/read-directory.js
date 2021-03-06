const fs = require('fs')
const path = require('path')
const Logger = require('../configuration/configuration').getLogger()
const Directory = require('../models/directory.model')
const File = require('../models/file.model')
const getFileType = require('../extra/get-file-type')

async function readDirectory(dirToRead) {
  let dir
  let dirToReadStats
  let dirents

  try {
    dirToReadStats = await fs.promises.stat(dirToRead)
    dirents = await fs.promises.readdir(dirToRead)
    dir = new Directory(path.basename(dirToRead), dirToRead, 0, true, null, 0, 0)

    dir.size = dirToReadStats.size
    for (let d of dirents) {
      const stat = await fs.promises.stat(path.join(dirToRead, d))
      dir.size += stat.size;

      if (stat.isFile()) {
        const fileTypeObject = await getFileType(path.join(dirToRead, d))

        dir.files++
        let file = new File(d.replace(path.extname(d),''), 
          path.join(dirToRead, d),
          stat.size, '', true);
        file.mediaType = fileTypeObject.mime
        file.extension = fileTypeObject.ext
        dir.contents.files.push(file)
      } else if (stat.isDirectory()) {
        const subdir = await readDirectory(path.join(dirToRead, d));
        dir.size += subdir.size;
        subdir.location = path.normalize(subdir.location)

        dir.subDirectories++
        dir.contents.directories.push(subdir)
      }
    }
  } catch(err) {
    /* fault tolarance:- make directory if does not exists */
    if (err.errno === -2) {
      await fs.promises.mkdir(dirToRead, {
        recursive: true
      })

      return readDirectory(dirToRead)
    } else {
      Logger.log(err)
      throw err
    }
  }

  return dir
}

module.exports = readDirectory
