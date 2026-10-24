// Repackage the existing LingoBar PNG icon sizes; no external image tools.
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const root = join(__dirname, '..', 'build')
const sizes = [16, 32, 64, 128, 256]
const names = ['16x16', '32x32', '32x32@2x', '128x128', '256x256']
const images = names.map((name, index) => {
  const data = readFileSync(join(root, 'icon.iconset', `icon_${name}.png`))
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(data.readUInt32BE(16), sizes[index])
  assert.equal(data.readUInt32BE(20), sizes[index])
  return data
})
const header = Buffer.alloc(6 + images.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
let offset = header.length
images.forEach((data, index) => {
  const entry = 6 + index * 16
  header[entry] = sizes[index] % 256
  header[entry + 1] = sizes[index] % 256
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(data.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += data.length
})
writeFileSync(join(root, 'icon.ico'), Buffer.concat([header, ...images]))
writeFileSync(join(root, 'tray.png'), images[1])
console.log('Windows ICO (16–256 px) and tray PNG generated from existing LingoBar artwork.')
