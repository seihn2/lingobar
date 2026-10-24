// Inspect only package contents; never start capture or contact providers.
const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const asar = require('@electron/asar')
const root = join(__dirname, '..')
const resources = process.platform === 'win32'
  ? join(root, 'dist', 'win-unpacked', 'resources')
  : process.platform === 'darwin'
    ? join(root, 'dist', 'mac-arm64', 'LingoBar.app', 'Contents', 'Resources')
    : null
if (!resources) throw new Error('Package verification requires macOS or Windows.')
const archive = join(resources, 'app.asar')
const files = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
for (const required of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html', 'LICENSE', 'NOTICE.md', 'licenses/Penumbra-LICENSE.txt'])
  assert.ok(files.includes(required), `Missing packaged ${required}`)
for (const file of files) {
  assert.ok(!/(^|\/)(settings\.json|saved\.json|diagnostics\.jsonl|\.env(?:\..*)?|\.npmrc|\.git|test|artifacts)(\/|$)/i.test(file), `Private or development file in package: ${file}`)
  assert.ok(!/\.(wav|mp3|pcm|pem|p12|pfx|key)$/i.test(file), `Unexpected sensitive file: ${file}`)
}
assert.ok(existsSync(join(resources, 'licenses', 'electron', 'LICENSE')))
assert.ok(readFileSync(join(resources, 'licenses', 'electron', 'LICENSES.chromium.html')).length > 1000)
assert.ok(existsSync(join(resources, 'native', `system-audio-capture${process.platform === 'win32' ? '.exe' : ''}`)))
if (process.platform === 'win32') {
  assert.ok(existsSync(join(resources, 'tray.png')))
  assert.equal(readFileSync(join(resources, 'icon.ico')).readUInt16LE(2), 1)
}
console.log(`Package contents, runtime notices, native helper and data exclusion passed (${process.platform}/${process.arch}).`)
