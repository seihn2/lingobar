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
  'seal.py': 'scripts/secure-key/seal.py',
  'session.py': 'scripts/secure-key/session.py',
  'envelope_crypto.py': 'scripts/secure-key/envelope_crypto.py',
  'requirements.txt': 'scripts/secure-key/requirements.txt',
  'key-transfer-envelope.json': 'scripts/secure-key/envelope.example.json',
  'key-transfer-receiver.json': 'scripts/secure-key/receiver.example.json',
  'GUIDE.md': 'docs/secure-key-transfer.md',
  'LICENSE': 'LICENSE', 'NOTICE.md': 'NOTICE.md',
  ...Object.fromEntries(['cryptography-LICENSE.txt', 'cryptography-LICENSE.APACHE.txt', 'cryptography-LICENSE.BSD.txt', 'cffi-LICENSE.txt', 'pycparser-LICENSE.txt'].map(name => [name, 'licenses/' + name]))
}
const files = Object.entries(inputs).map(([name, input]) => {
  const data = fs.readFileSync(path.join(root, input))
  fs.writeFileSync(path.join(output, name), data, { mode: 0o644 })
  return { path: name, bytes: data.length, sha256: hash(data) }
})
for (const name of ['key-transfer-envelope.json', 'key-transfer-receiver.json']) assert.equal(JSON.parse(fs.readFileSync(path.join(output, name), 'utf8')).enabled, false)
fs.writeFileSync(path.join(output, 'MANIFEST.json'), JSON.stringify({ schemaVersion: 1, sourceHead: head, sourceBase: process.env.LINGOBAR_SOURCE_BASE || '', sourceTree: tree, checkoutHead: git('rev-parse', 'HEAD'),
  enabled: false, credentialsIncluded: false, networkChanges: false, installationPerformed: false,
  input: 'Manual verified no-echo POSIX TTY only; no Electron decryption or clipboard access',
  envelopeProfileVersion: 1, receiverProfileVersion: 2, privilegeChanges: false,
  transport: 'Ciphertext only through existing authorized Azure channel; no SSH/NSG/sudo changes or plaintext transit',
  encryption: 'PyCA cryptography50.0.0 RSA4096 OAEP-SHA256; trusted Azure canonical challenge pin; target/purpose/session/300-second expiry',
  dependencyInstallationPerformed: false, dependenciesBundled: false,
  dependencyPrerequisite: 'Hash-locked Python3.12 binary wheels; operator-reviewed environment required; no automatic install',
  privateKey: 'One-shot protected Linux process memory only; no serialization/restart/replay; local same-UID Unix socket',
  coreProtection: 'Verified RLIMIT_CORE hard/soft0 and Linux own-process dumpable0; no plaintext child exec; SIGQUIT and repeated-cancellation cleanup',
  receiver: 'Linux private create-only JSON target; anonymous O_TMPFILE; no named plaintext staging or overwrite',
  validation: 'Synthetic PTY, dummy RSA envelopes, same-UID Unix sockets and temporary Linux targets only; no user Mac/live VM/Azure/provider acceptance', files }, null, 2) + '\n')
const entries = [...files, { path: 'MANIFEST.json', sha256: hash(fs.readFileSync(path.join(output, 'MANIFEST.json'))) }]
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), entries.map(item => `${item.sha256}  ${item.path}`).join('\n') + '\n')
console.log(`Default-disabled key-transfer tools archived: ${files.length} files; no secret or installation.`)
