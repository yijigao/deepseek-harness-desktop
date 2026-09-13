'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Use a browser-native PNG, independently of the Windows executable's ICO.
function titlebarLogoDataUrl(appRoot, resourcesRoot, packaged) {
  const filename = packaged ? path.join(resourcesRoot, 'icon-preview.png') : path.join(appRoot, 'build', 'icon-preview.png')
  try {
    const bytes = fs.readFileSync(filename)
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return ''
    return 'data:image/png;base64,' + bytes.toString('base64')
  } catch { return '' }
}
module.exports = { titlebarLogoDataUrl }
