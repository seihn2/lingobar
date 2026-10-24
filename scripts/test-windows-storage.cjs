const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
if (process.platform !== 'win32') throw new Error('Windows safeStorage verification requires Windows.')
const environment = { ...process.env }
// On Windows the presence of this variable (even an empty value) selects Node
// mode, where Electron's app/safeStorage modules do not exist.
delete environment.ELECTRON_RUN_AS_NODE
const output = execFileSync(require('electron'), [join(__dirname, '..', 'test', 'fixtures', 'windows-storage.cjs')], {
  encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false,
  env: environment
})
assert.match(output, /WINDOWS_DPAPI_SYNTHETIC_OK/)
console.log('Actual Windows safeStorage/DPAPI synthetic round trip passed; no real keys or providers.')
