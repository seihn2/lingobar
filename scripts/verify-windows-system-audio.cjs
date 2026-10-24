// Synthetic only: never use --capture here or touch an audio device/provider.
// Adapted from seihn2/penumbra at 1b023aad26fc601045fc7948fe16666272d37661.
// CC BY-NC 4.0; see NOTICE.md.
const { execFileSync, spawn, spawnSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')

const root = join(__dirname, '..')
const readyMessage = { type: 'ready', protocol: 1, sampleRate: 16000, channels: 1, format: 'pcm_s16le' }
const options = { cwd: root, windowsHide: true, shell: false }

function validatePe(path) {
  const data = readFileSync(path)
  assert.ok(data.length >= 64, 'Truncated executable')
  assert.equal(data.toString('ascii', 0, 2), 'MZ')
  const offset = data.readUInt32LE(0x3c)
  assert.ok(offset + 6 <= data.length, 'Invalid executable header')
  assert.equal(data.toString('ascii', offset, offset + 4), 'PE\0\0')
  assert.equal(data.readUInt16LE(offset + 4), 0x8664, `Expected x64 executable: ${path}`)
}

function smoke(executable, mode) {
  return new Promise((resolve, reject) => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, stdio: 'ignore' })
    const child = spawn(executable, ['--self-test-stream', '--parent-pid', String(owner.pid)], {
      ...options, stdio: ['pipe', 'pipe', 'pipe']
    })
    let control = ''
    let binary = Buffer.alloc(0)
    let ready = false
    let frame = false
    let terminalError = false
    let actionSent = false
    let finished = false
    const finish = (error) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      owner.kill()
      if (child.exitCode === null) child.kill()
      if (error) reject(error)
      else resolve()
    }
    const deadline = setTimeout(() => finish(new Error(`Audio helper ${mode} timed out`)), 10000)
    for (const process of [owner, child]) process.once('error', finish)
    child.stdin.on('error', error => { if (!actionSent) finish(error) })
    // For backpressure leave stdout paused until the child exits. Never collect
    // all streamed bytes; validate at most one bounded frame in other modes.
    if (mode !== 'backpressure') child.stdout.on('data', chunk => {
      if (frame) return
      binary = Buffer.concat([binary, chunk])
      try {
        assert.ok(binary.length <= 131072)
        if (binary.length < 8) return
        assert.equal(binary.toString('ascii', 0, 4), 'PCM1')
        const bytes = binary.readUInt32LE(4)
        assert.ok(bytes >= 2 && bytes <= 8192 && bytes % 2 === 0)
        if (binary.length < bytes + 8) return
        assert.ok(binary.subarray(8, bytes + 8).every(value => value === 0), 'Expected synthetic silence')
        frame = true
        binary = Buffer.alloc(0)
        actionSent = true
        if (mode === 'stdout-closed') child.stdout.destroy()
        else if (mode === 'parent-exit') owner.kill()
        else child.stdin.end()
      } catch (error) { finish(error) }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      control += chunk
      try {
        assert.ok(control.length <= 4096)
        let end
        while ((end = control.indexOf('\n')) >= 0) {
          const line = control.slice(0, end).replace(/\r$/, '')
          control = control.slice(end + 1)
          const message = JSON.parse(line)
          if (!ready) {
            assert.deepEqual(message, readyMessage)
            ready = true
          } else {
            assert.ok(['backpressure', 'stdout-closed'].includes(mode))
            assert.deepEqual(message, { type: 'error', code: mode === 'backpressure' ? 'buffer-overflow' : 'transport-error' })
            assert.equal(terminalError, false, 'Repeated terminal error')
            terminalError = true
          }
        }
      } catch (error) { finish(error) }
    })
    child.once('exit', () => {
      // A paused Readable can keep close pending after exit. Drain only now,
      // after the watchdog has proven the blocked writer does not stay alive.
      if (mode === 'backpressure') child.stdout.resume()
    })
    child.once('close', code => {
      try {
        assert.ok(ready, 'Helper exited without ready')
        assert.equal(control, '', 'Truncated control message')
        if (mode === 'backpressure' || mode === 'stdout-closed') {
          assert.equal(code, 1, 'A broken or blocked pipe must fail visibly')
          assert.ok(terminalError, 'Missing terminal error')
          if (mode === 'stdout-closed') assert.ok(frame)
        } else {
          assert.ok(frame, 'Missing complete synthetic PCM frame')
          assert.equal(code, 0, 'Normal lifetime stop must succeed')
        }
        finish()
      } catch (error) { finish(error) }
    })
  })
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('Windows x64 helper verification requires a Windows x64 host.')
  const development = join(root, 'resources', 'native', 'win-x64', 'system-audio-capture.exe')
  const packaged = join(root, 'dist', 'win-unpacked', 'resources', 'native', 'system-audio-capture.exe')
  // --native-only is useful before packaging; default additionally checks the
  // actual packaged binary and requires byte-for-byte resource consistency.
  if (process.argv.slice(2).some(arg => arg !== '--native-only')) throw new Error('Unknown verification option')
  const paths = process.argv.includes('--native-only') ? [development] : [development, packaged]
  for (const path of paths) {
    validatePe(path)
    assert.equal(execFileSync(path, ['--self-test'], { ...options, encoding: 'utf8', timeout: 10000 }).trim(), 'SELF_TEST_OK')
    for (const args of [[], ['--capture'], ['--self-test-stream', '--parent-pid', '0'],
      ['--self-test-stream', '--parent-pid', '-1'], ['--self-test-stream', '--parent-pid', '4294967296'],
      ['--self-test-stream', '--parent-pid', 'not-a-pid'], ['--unknown', '--parent-pid', String(process.pid)]]) {
      // All are rejected before creating COM audio objects.
      const result = spawnSync(path, args, { ...options, encoding: 'utf8', timeout: 5000 })
      if (result.error) throw result.error
      assert.equal(result.status, 2, 'Invalid arguments must fail before capture')
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, '')
    }
    for (const mode of ['stdin-eof', 'parent-exit', 'stdout-closed', 'backpressure', 'stdin-eof']) await smoke(path, mode)
  }
  if (paths.length === 2) assert.deepEqual(readFileSync(packaged), readFileSync(development), 'Packaged helper differs from the built helper')
  console.log(`Windows x64 audio helper: ${paths.length} binary path(s), frame sizes/error classification, PCM1 silence, EOF/restart, parent cleanup, broken pipe, backpressure and argument validation passed. No real capture or provider calls.`)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
