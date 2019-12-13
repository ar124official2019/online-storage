const getMountRoot = require('../configuration/configuration').getMountRoot
const path = require('path')
const fs = require('fs')
const Logger = require('../configuration/configuration').getLogger()

async function createStorage(email, firstName, secondName) {
  email = String(email).toLowerCase().replace(/[@_\.\-]/g, '')
  firstName = String(firstName).toLowerCase().replace(/[@_\.\-]/g, '')
  secondName = String(secondName).toLowerCase().replace(/[@_\.\-]/g, '')

  try {
    const mountRoot = await getMountRoot() 
    let storagePath = path.join(mountRoot, `${secondName}${email}${firstName}`)
    const storage = await fs.promises.mkdir(storagePath, { recursive: true })
  } catch(err) {
    Logger.log(err)
    throw err
  }
}

module.exports = createStorage
