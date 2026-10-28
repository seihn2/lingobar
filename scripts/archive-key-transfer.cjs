// Static operator-tool package only. Never load a configured profile, decrypt or transfer a key.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), output = path.join(root, 'dist/key-transfer')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const head = process.env.LINGOBAR_SOURCE_HEAD || git('rev-parse', 'HEAD')
assert.match(head, /^[a-f0-9]{40}$/)
assert.equal(git('status', '--porcelain'), '', 'Key-transfer artifact requires clean source')
const tree = git('rev-parse', `${head}^{tree}`)
assert.equal(git('rev-parse', 'HEAD^{tree}'), tree, 'CI checkout must equal the recorded source tree')
fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true })
const inputs = {
  'send.py': 'scripts/secure-key/send.py',
  'receive.py': 'scripts/secure-key/receive.py',
  'key-transfer-sender.json': 'scripts/secure-key/sender.example.json',
  'key-transfer-receiver.json': 'scripts/secure-key/receiver.example.json',
  'GUIDE.md': 'docs/secure-key-transfer.md',
  'LICENSE': 'LICENSE', 'NOTICE.md': 'NOTICE.md'
}
const files = Object.entries(inputs).map(([name, input]) => {
  const data = fs.readFileSync(path.join(root, input))
  fs.writeFileSync(path.join(output, name), data, { mode: 0o644 })
  return { path: name, bytes: data.length, sha256: hash(data) }
})
for (const name of ['key-transfer-sender.json', 'key-transfer-receiver.json']) assert.equal(JSON.parse(fs.readFileSync(path.join(output, name), 'utf8')).enabled, false)
fs.writeFileSync(path.join(output, 'MANIFEST.json'), JSON.stringify({ schemaVersion: 1, sourceHead: head, sourceBase: process.env.LINGOBAR_SOURCE_BASE || '', sourceTree: tree, checkoutHead: git('rev-parse', 'HEAD'),
  enabled: false, credentialsIncluded: false, networkChanges: false, installationPerformed: false,
  input: 'Manual verified no-echo POSIX TTY only; no Electron decryption or clipboard access',
  transport: 'Existing SSH authentication, literal pinned host/key and fixed receiver command; API key only on stdin',
  receiver: 'Linux private create-only JSON target; anonymous O_TMPFILE; no named plaintext staging or overwrite',
  validation: 'Synthetic PTY, mocked SSH and temporary Linux targets only; no user Mac, live VM, key or network acceptance', files }, null, 2) + '\n')
const entries = [...files, { path: 'MANIFEST.json', sha256: hash(fs.readFileSync(path.join(output, 'MANIFEST.json'))) }]
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), entries.map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n')
console.log(`Default-disabled key-transfer tools archived: ${files.length} files; no secret or installation.`)
