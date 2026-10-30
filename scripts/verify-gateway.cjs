const { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } = require('node:fs')
const { resolve, join } = require('node:path')
const { tmpdir } = require('node:os')
const { spawnSync } = require('node:child_process')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '../dist/gateway')
const bundle = readFileSync(join(root, 'gateway.cjs'), 'utf8')
for (const marker of ['synthetic-asr', 'synthetic-translation', 'test/gateway', 'from "electron"', 'require("electron")']) assert.ok(!bundle.includes(marker), marker)
assert.match(bundle, /127\.0\.0\.1/)
const example = readFileSync(join(root, 'gateway.env.example'), 'utf8')
assert.match(example, /^WEB_ENABLED=0$/m)
assert.match(example, /^ASR_API_KEY=$/m); assert.match(example, /^TRANSLATION_API_KEY=$/m)
assert.match(example, /^GATEWAY_DAILY_SESSIONS=0$/m); assert.match(example, /^GATEWAY_DAILY_COMPLETION_REQUESTS=0$/m)
assert.ok(readFileSync(join(root, 'licenses/ws-LICENSE.txt')).length)
const installation = JSON.parse(readFileSync(join(root, 'scripts/text-test-installation.json'), 'utf8'))
assert.equal(installation.executionEnabled, false)
assert.equal(installation.ledgerDirectory, null); assert.equal(installation.credentialsFile, null)
const proof = JSON.parse(readFileSync(join(root, 'evidence/text-test-proof.json'), 'utf8'))
assert.equal(proof.executionAllowed, false)
for (const match of readFileSync(join(root, 'one-rmb-test.md'), 'utf8').matchAll(/\]\(([^)]+)\)/g)) {
  if (!/^(?:https?:|#)/.test(match[1])) assert.ok(existsSync(resolve(root, match[1].split('#')[0])), `Missing packaged guide target: ${match[1]}`)
}
const temporary = mkdtempSync(join(tmpdir(), 'lingobar-packaged-test-denied-'))
try {
  const attempted = join(temporary, 'network-attempted'), preload = join(temporary, 'deny-network.cjs')
  writeFileSync(preload, `const fs=require('node:fs');const deny=()=>{fs.writeFileSync(${JSON.stringify(attempted)},'denied');throw new Error('Synthetic network denied')};globalThis.fetch=deny;globalThis.WebSocket=class{constructor(){deny()}};for(const n of ['http','https']){const m=require('node:'+n);m.request=deny;m.get=deny}const net=require('node:net');net.connect=deny;net.createConnection=deny;net.Socket.prototype.connect=deny;require('node:tls').connect=deny;\n`)
  for (const args of [[], ['--dry-run'], ['--execute']]) {
    const child = spawnSync(process.execPath, ['--require', preload, join(root, 'audio-test.cjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 5000, env: {} })
    assert.equal(child.status, args.includes('--execute') ? 2 : 0)
    const result = JSON.parse(child.stdout.trim())
    assert.equal(result.status, args.includes('--execute') ? 'blocked' : 'dry-run')
    assert.equal(result.asrAttempts, 0); assert.equal(result.translationAttempts, 0)
    assert.equal(result.reservedMicroCny, 0)
    assert.equal(existsSync(attempted), false, 'Default one-shot runner attempted network')
  }
  for (const step of ['translation', 'ruby']) {
    const child = spawnSync(process.execPath, ['--require', preload, join(root, 'scripts/run-one-rmb-text-test.cjs'), step], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { WEB_ENABLED: '1', TRANSLATION_API_KEY: 'SYNTHETIC-KEY-MUST-NOT-LEAK' }
    })
    assert.equal(child.status, 2, `Packaged ${step} must refuse default installation`)
    assert.equal(child.stderr, '')
    const result = JSON.parse(child.stdout.trim())
    assert.equal(result.step, step); assert.equal(result.status, 'blocked')
    assert.equal(result.executionAllowed, false); assert.equal(result.providerCalls, 0)
    assert.ok(!child.stdout.includes('SYNTHETIC-KEY-MUST-NOT-LEAK'))
    assert.equal(existsSync(attempted), false, 'Default-closed CLI attempted network')
  }
} finally { rmSync(temporary, { recursive: true, force: true }) }
console.log('Node gateway and fixed text CLI inspected: disabled configuration, uninitialized ledger, zero network/credential calls, no fixtures/Electron or embedded secrets; no deployment claim.')
