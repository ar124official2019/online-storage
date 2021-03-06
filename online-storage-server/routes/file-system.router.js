const express = require('express')
const fileSystemRouter = express.Router()
const path = require('path')
const multer = require('multer')
const User = require('../models/user.model')
const Logger = require('../configuration/configuration').getLogger()
const httpMessages = require('http').STATUS_CODES
const readDirectory = require('../extra/read-directory')
const decryptAuth = require('../extra/decrypt-auth')
const File = require('../models/file.model')
const getFileType = require('../extra/get-file-type')
const fs = require('fs')
const copyDirectoryRecursive = require('../extra/copy-directory-recursive')

// we first must check request authentication
var authenticateUser = function(req, res, next) {
  if (!(req.get('Authorization'))) {
    res.set('WWW-Authenticate', 'Basic')
    res.status(401).json({
      error: httpMessages['401']
    })
  }

  const auth = decryptAuth(req.get('Authorization'))

  User.findOne({
    email: auth.email
  }, (err, doc) => {
    if (err) {
      Logger.log(err)
      res.status(500).end()
    } else {
      if (doc === null || !auth.password) {
        res.status(403).json({
          error: httpMessages['403']
        })
      } else {
        if (doc.validatePassword(auth.password)) {
          req.storagePath = doc.storagePath
          next()
        } else {
          res.status(403).json({
            error: httpMessages['403']
          })
        }
      }
    }
  })
}

function fixLocations(directory, storagePath) {
  for (let i = 0; i < directory.contents.directories.length; i++) {
    directory.contents.directories[i].location = 
      directory.contents.directories[i].location.replace(storagePath, '')
    fixLocations(directory.contents.directories[i], storagePath)
  }

  for (let i = 0; i < directory.contents.files.length; i++) {
    directory.contents.files[i].location = 
      directory.contents.files[i].location.replace(storagePath, '')
  }

  return directory
}


// authenticate each and every request
fileSystemRouter.all('/fileSystem', authenticateUser)
fileSystemRouter.all('/fileSystem/:file', authenticateUser)

// requests of getting files and directories
fileSystemRouter.get('/fileSystem', async (req, res, next) => {
  // request is about download a file
  if (req.headers['file-location']) {
    const file = path.join(req.storagePath, req.headers['file-location'])
    res.sendFile(file)
  } else {
    // by default root directory is sent
    let directory = req.storagePath

    // request is about getting specific directory
    if (req.headers['directory-location']) {
      directory = path.join(req.storagePath, req.headers['directory-location'])
    }

    const responce = await readDirectory(directory)

    responce.location = responce.location.replace(req.storagePath,'')
    if (responce.location == '') {
      responce.name = 'root'
      responce.location = '/'
    }

    fixLocations(responce, req.storagePath)
    res.json(responce)
  }
})

fileSystemRouter.get('/fileSystem/:file', async (req, res) => {
  try {
    const file =  path.join(req.storagePath, req.params.file)
    const stream = fs.createReadStream(file)
    const stat = await fs.promises.stat(file)
    const fileTypeObject = await getFileType(file)

    res.writeHead(200, {
      'Content-Type': fileTypeObject.mime,
      'Content-Length': stat.size
    })
    stream.pipe(res)
  } catch(err) {
    if (err.errno === -2) {
      res.status(404).end()
    } else {
      res.status(504).end()
    }
  }
})

let upload = multer({
  dest: path.join(path.join('..', '/uploads'))
})

// Request of creating directories or uploading files
fileSystemRouter.post('/fileSystem', upload.array('file[]', 20), async (req, res, next) => {
  let responce = []

  // request is about creating directories
  if (req.get('Create-Directory')) {
    for (let i = 0; i < req.body.locations.length; i++) {
      fs.promises.mkdir(path.join(req.storagePath, req.body.locations[i]), {
        recursive: true
      })
        .then(() => {
          responce.push(req.body.locations[i])

          if (i === req.body.locations.length - 1) {
            res.json(responce)
          }
        }).catch(err => {
          Logger.log(err)
          res.status(500).end()
        })
    }
  } else {
    // perhaps an unknown request
    if (!req.files) {
      res.status(400).end();
    }

    // request is about uploading files
    try {
      for (let i = 0; i < req.files.length; i++) {
        await fs.promises.rename(req.files[i].path, path.join(req.storagePath,
          req.body.location, req.body.name[i]))

        const file = new File(req.body.name[i],
          path.join(req.storagePath, req.body.location, req.body.name[i]))

        const stats = await fs.promises.stat(file.location)
        file.size = stats.size;
        file.exists = true;
        const fileTypeObject = await getFileType(file.location)
        file.mediaType = fileTypeObject.mime
        file.extension = fileTypeObject.ext
        file.location = file.location.replace(req.storagePath, '/')

        responce.push(file)

        if (i == req.files.length - 1) {
          res.json(responce)
        }
      }
    } catch(err) {
      Logger.log(err)

      /* cleanup */
      try {
        for (f of req.files) {
          await fs.promises.unlink(f.path)
        }
      } catch(err) {
        Logger.log(err) // just log, not a serious issue
      }

      res.status(500).end()
    }
  }
})

fileSystemRouter.put('/fileSystem', async (req, res, next) => {
  let from = [], response = [], to = []

  // prepare location pairs
  for (let i=0; i < req.body.pairs.length; i++) {
    from[i] = req.body.pairs[i].from
    to[i] = req.body.pairs[i].to
  }

  try {

    for (let i=0; i < req.body.pairs.length; i++) {

      // a rename request: rename directories and files
      if (!req.body.keep) {
          await fs.promises.rename(
           path.join(req.storagePath, from[i].location),
           path.join(req.storagePath, to[i].location))
          if (to[i].mediaType === 'directory') {
            const responseDirectory = await readDirectory(path.join(req.storagePath,
              to[i].location))
            fixLocations(responseDirectory, req.storagePath)
            response.push(responseDirectory)
          } else {
            response.push(to[i]);
          }
      // a copy request: copy files and directories
      } else {
        console.log(req.body.pairs)
        // target is a directory: copy directory recursively
        if (from[i].mediaType === 'directory') {
          // create directory, if it does not exist
          await fs.promises.mkdir(path.join(req.storagePath, to[i].location), {
            recursive: true
          })

          // copy directory recursively
          await copyDirectoryRecursive(
            path.join(req.storagePath, from[i].location),
            path.join(req.storagePath, to[i].location))

          // now read directory as Directory object
          const responseDirectory = await readDirectory(
            path.join(req.storagePath, to[i].location))
          fixLocations(responseDirectory, req.storagePath)

          // push Directory object
          response.push(responseDirectory)

        // target is a file: copy single file
        } else {
          await fs.promises.copyFile(
            path.join(req.storagePath, from[i].location), 
            path.join(req.storagePath, to[i].location))
          response.push(to[i])
        }
      }

      if (i === req.body.pairs.length - 1)
        res.json(response)
    }
  } catch(err) {
    Logger.log(err);
    res.status(500).end()
  }
})

fileSystemRouter.delete('/fileSystem', async (req, res, next) => {
  let locations = req.get('locations')
  locations = locations.split(';')
  const locationsPairs = []
  const responce = []

  for (let i = 0; i < locations.length; i++) {
    locationPair = locations[i].split(':')
    locationsPairs.push({
      location: locationPair[0],
      mediaType: locationPair[1]
    })
  }

  try {
    for (const l of locationsPairs) {
      if (l.mediaType === 'directory') {
        await fs.promises.rmdir(path.join(req.storagePath, l.location), {
          recursive: true
        })
        responce.push(l)
      } else {
        await fs.promises.unlink(path.join(req.storagePath, l.location))
        responce.push(l)
      }
    }
  } catch(err) {
    Logger.log(err);
    res.status(500).end()
  } finally {
    res.json(responce)
  }

})

module.exports = fileSystemRouter
