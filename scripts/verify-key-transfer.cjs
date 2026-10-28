const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const directory = path.resolve(__dirname, '../dist/key-transfer')
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'MANIFEST.json'), 'utf8'))
assert.equal(manifest.enabled, false); assert.equal(manifest.credentialsIncluded, false)
for (const item of manifest.files) {
  const bytes = fs.readFileSync(path.join(directory, item.path))
  assert.equal(bytes.length, item.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256)
}
const sender = JSON.parse(fs.readFileSync(path.join(directory, 'key-transfer-sender.json')))
const receiver = JSON.parse(fs.readFileSync(path.join(directory, 'key-transfer-receiver.json')))
assert.equal(sender.enabled, false); assert.equal(sender.host, null); assert.equal(sender.hostKey, null)
assert.equal(receiver.enabled, false); assert.equal(receiver.credentialsFile, null)
// Run only shipped disabled entrypoints. Block socket/process creation before loading either script.
const bootstrap = `import sys,runpy,subprocess,socket\nattempts=[]\ndef deny(*a,**k):\n attempts.append(True)\n raise RuntimeError('NETWORK_OR_PROCESS_FORBIDDEN')\nsubprocess.Popen=deny\nsocket.socket=deny\nsys.argv=sys.argv[1:]\ncode=0\ntry:\n runpy.run_path(sys.argv[0],run_name='__main__')\nexcept SystemExit as e:\n code=e.code\nfinally:\n if attempts: code=77\nsys.exit(code)\n`
for (const [name, args] of [['send.py', []], ['receive.py', ['--probe']], ['receive.py', ['--receive']]]) {
  const result = spawnSync('python3', ['-I', '-B', '-c', bootstrap, path.join(directory, name), ...args], {
    cwd: directory, input: '', encoding: 'utf8', timeout: 5000, maxBuffer: 8192,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
  })
  assert.equal(result.status, 2, `${name} must fail closed`)
  assert.ok(!result.error); assert.ok(!result.stdout.includes('NETWORK_OR_PROCESS_FORBIDDEN')); assert.ok(!result.stderr.includes('NETWORK_OR_PROCESS_FORBIDDEN'))
  const output = JSON.parse(result.stdout.trim()); assert.equal(output.status, 'blocked')
}
console.log('Key-transfer bundle verified: default denied with subprocess/network blocked; source hashes match; no real key or SSH execution.')
