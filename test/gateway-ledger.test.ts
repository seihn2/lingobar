import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync, linkSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const fs = require('node:fs')
const modulePath = require.resolve('../scripts/plan-one-rmb-test.cjs')
const { initializeLedger, OneRmbTestLedger } = require(modulePath)
const roots: string[] = [], held: Array<{ close(): void }> = []
function directory() { const dir = mkdtempSync(join(tmpdir(), 'lingobar-ledger-hardening-')); roots.push(dir); return dir }
function open(dir: string) { const ledger = new OneRmbTestLedger(dir); held.push(ledger); return ledger }
function fixture() { const dir = directory(); initializeLedger(dir); return { dir, file: join(dir, 'test-budget.json'), ledger: open(dir) } }
function rewrite(dir: string, patch: (original: any) => any) { const file = join(dir, 'test-budget.json'); writeFileSync(file, JSON.stringify(patch(JSON.parse(readFileSync(file, 'utf8'))))) }
const requestHash = 'a'.repeat(64)
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers()
  for (const ledger of held.splice(0)) { try { ledger.close() } catch {} }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('strict lifetime test ledger (synthetic temporary files only)', () => {
  it.each([
    ['unknown top field', (v: any) => ({ ...v, extra: true })],
    ['unknown attempt field', (v: any) => ({ ...v, reservedMicroCny: 20_000, attempts: [{ step: 'translation', reservedMicroCny: 20_000, extra: true }] })],
    ['unknown schema', (v: any) => ({ ...v, version: 2 })],
    ['unknown batch', (v: any) => ({ ...v, batchId: 'another-batch' })],
    ['unknown currency', (v: any) => ({ ...v, currency: 'USD' })],
    ['changed total allowance', (v: any) => ({ ...v, limitMicroCny: 2_000_000 })],
    ['fractional amount', (v: any) => ({ ...v, reservedMicroCny: 0.1 })],
    ['mismatched sum', (v: any) => ({ ...v, reservedMicroCny: 20_000 })],
    ['wrong fixed step amount', (v: any) => ({ ...v, reservedMicroCny: 10_000, attempts: [{ step: 'translation', reservedMicroCny: 10_000 }] })],
    ['duplicate step', (v: any) => ({ ...v, reservedMicroCny: 40_000, attempts: [{ step: 'ruby', reservedMicroCny: 20_000 }, { step: 'ruby', reservedMicroCny: 20_000 }] })],
    ['legacy ASR money', (v: any) => ({ ...v, reservedMicroCny: 10_000, attempts: [{ step: 'asr', reservedMicroCny: 10_000 }] })],
    ['unknown model metadata', (v: any) => ({ ...v, model: 'future-model' })],
    ['array top', () => []],
    ['null top', () => null],
  ])('rejects %s without rewriting the source', (_label, patch) => {
    const dir = directory(); initializeLedger(dir); rewrite(dir, patch)
    const before = readFileSync(join(dir, 'test-budget.json'), 'utf8')
    expect(() => open(dir)).toThrow()
    expect(readFileSync(join(dir, 'test-budget.json'), 'utf8')).toBe(before)
  })

  it('fsyncs the explicit initial file and containing directory before releasing its own lock', () => {
    const dir = directory(), actual = fs.fsyncSync, seen: string[] = []
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: unknown) => { seen.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return actual(fd) })
    initializeLedger(dir)
    expect(seen).toEqual(['file', 'directory'])
    expect(existsSync(join(dir, 'test-budget.lock'))).toBe(false)
  })
  it.each(['write', 'file_sync', 'directory_sync', 'file_close'])('retains an uncertain initialization lock after %s failure', stage => {
    const dir = directory(), actualWrite = fs.writeFileSync, actualSync = fs.fsyncSync, actualClose = fs.closeSync
    let closeFailed = false
    const spy = stage === 'file_close' ? vi.spyOn(fs, 'closeSync').mockImplementation((fd: unknown) => {
      if (!closeFailed && !fs.fstatSync(fd).isDirectory()) { closeFailed = true; throw new Error('synthetic close failure') }
      return actualClose(fd)
    }) : stage === 'write' ? vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('synthetic write failure') }) :
      vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: unknown) => {
        if ((stage === 'directory_sync') === fs.fstatSync(fd).isDirectory()) throw new Error('synthetic sync failure')
        return actualSync(fd)
      })
    expect(() => initializeLedger(dir)).toThrow(); spy.mockRestore()
    expect(existsSync(join(dir, 'test-budget.lock'))).toBe(true)
    expect(() => open(dir)).toThrow()
    expect(() => initializeLedger(dir)).toThrow()
    expect(fs.writeFileSync).toBe(actualWrite)
  })
  it('refuses residual pending and stale lock files immediately and never removes them', () => {
    const dir = directory(); initializeLedger(dir)
    for (const name of ['test-budget.pending', 'test-budget.lock']) {
      const file = join(dir, name); writeFileSync(file, 'synthetic-stale-marker', { mode: 0o600 })
      expect(() => open(dir)).toThrow(); expect(() => initializeLedger(dir)).toThrow()
      expect(readFileSync(file, 'utf8')).toBe('synthetic-stale-marker'); unlinkSync(file)
    }
  })
  it('refuses missing files without silently reinitializing', () => {
    const dir = directory(); expect(() => open(dir)).toThrow(); expect(existsSync(join(dir, 'test-budget.json'))).toBe(false)
  })
  it.each(['directory_alias', 'file_symlink', 'lock_symlink', 'hard_link', 'directory_permissions', 'file_permissions'])('rejects unsafe %s', kind => {
    const dir = directory(); initializeLedger(dir); const aliasParent = directory(), file = join(dir, 'test-budget.json')
    let target = dir
    if (kind === 'directory_alias') { target = join(aliasParent, 'alias'); symlinkSync(dir, target) }
    if (kind === 'file_symlink') { const bytes = readFileSync(file); unlinkSync(file); writeFileSync(join(aliasParent, 'actual.json'), bytes, { mode: 0o600 }); symlinkSync(join(aliasParent, 'actual.json'), file) }
    if (kind === 'lock_symlink') symlinkSync(join(aliasParent, 'absent'), join(dir, 'test-budget.lock'))
    if (kind === 'hard_link') linkSync(file, join(aliasParent, 'hard.json'))
    if (kind === 'directory_permissions') chmodSync(dir, 0o755)
    if (kind === 'file_permissions') chmodSync(file, 0o644)
    expect(() => open(target)).toThrow()
  })
  it.each(['deleted', 'rewritten', 'permission_change'])('poisons an existing holder if its ledger is %s before the next write', change => {
    const f = fixture()
    if (change === 'deleted') unlinkSync(f.file)
    if (change === 'rewritten') rewrite(f.dir, v => ({ ...v, reservedMicroCny: 999 }))
    if (change === 'permission_change') chmodSync(f.file, 0o644)
    expect(() => f.ledger.reserve('translation')).toThrow(); expect(f.ledger.failed).toBe(true)
    expect(() => f.ledger.reserve('ruby')).toThrow()
  })
  it.each(['pending_open', 'write', 'file_sync', 'file_close', 'rename', 'directory_open', 'directory_sync', 'directory_close'])('poisons after every atomic reservation failure: %s', stage => {
    const f = fixture(), original = { open: fs.openSync, write: fs.writeFileSync, sync: fs.fsyncSync, rename: fs.renameSync, close: fs.closeSync }
    let renamed = false, closeFailed = false
    if (stage === 'pending_open' || stage === 'directory_open') vi.spyOn(fs, 'openSync').mockImplementation((file: unknown, ...rest: unknown[]) => {
      if ((stage === 'pending_open' && String(file).endsWith('.pending')) || (stage === 'directory_open' && renamed && file === f.dir)) throw new Error('synthetic open failure')
      return original.open(file, ...rest)
    })
    if (stage === 'write') vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('synthetic write failure') })
    if (stage === 'file_close' || stage === 'directory_close') vi.spyOn(fs, 'closeSync').mockImplementation((fd: unknown) => {
      const matches = stage === 'directory_close' ? fs.fstatSync(fd).isDirectory() : !fs.fstatSync(fd).isDirectory() && fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('.pending')
      if (matches && !closeFailed) { closeFailed = true; throw new Error('synthetic close failure') }
      return original.close(fd)
    })
    if (stage === 'file_sync' || stage === 'directory_sync') vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: unknown) => {
      if ((stage === 'directory_sync') === fs.fstatSync(fd).isDirectory()) throw new Error('synthetic sync failure')
      return original.sync(fd)
    })
    vi.spyOn(fs, 'renameSync').mockImplementation((...args: any[]) => { if (stage === 'rename') throw new Error('synthetic rename failure'); original.rename(...args); renamed = true })
    expect(() => f.ledger.reserve('translation')).toThrow(); expect(f.ledger.failed).toBe(true)
    expect(() => f.ledger.reserve('ruby')).toThrow()
    vi.restoreAllMocks(); f.ledger.close()
    if (renamed) {
      const reopened = open(f.dir)
      expect(reopened.reservedMicroCny).toBe(20_000); expect(() => reopened.reserve('translation')).toThrow()
    } else if (existsSync(join(f.dir, 'test-budget.pending'))) expect(() => open(f.dir)).toThrow()
  })

  it('records only bounded outcome metadata, no refund or repeat outcome, with anomaly persisted across reopen', () => {
    const f = fixture(); f.ledger.reserve('translation')
    f.ledger.recordOutcome('translation', 'succeeded', requestHash)
    expect(f.ledger.reservedMicroCny).toBe(20_000)
    expect(() => f.ledger.recordOutcome('translation', 'succeeded', requestHash)).toThrow()
    f.ledger.reserve('ruby'); f.ledger.recordOutcome('ruby', 'usage_anomaly', requestHash, 'usage_anomaly', true)
    expect(f.ledger.failed).toBe(true); f.ledger.close()
    const next = open(f.dir); expect(next.failed).toBe(true); expect(next.reservedMicroCny).toBe(40_000)
    expect(() => next.reserve('translation')).toThrow()
    const data = JSON.parse(readFileSync(f.file, 'utf8'))
    expect(data.attempts[0].outcome).toEqual({ status: 'succeeded', requestSha256: requestHash, at: expect.any(Number), errorCategory: null, anomaly: false })
  })
  it.each([
    { extra: true }, { status: 'unknown' }, { requestSha256: 'wrong' }, { at: 1.5 }, { errorCategory: 'raw private text' }, { anomaly: 'true' }, { status: 'usage_anomaly', anomaly: false }
  ])('rejects malformed persisted outcome %# without resetting its reservation', patch => {
    const dir = directory(); initializeLedger(dir)
    const outcome = { status: 'succeeded', requestSha256: requestHash, at: Date.now(), errorCategory: null, anomaly: false, ...patch }
    rewrite(dir, v => ({ ...v, reservedMicroCny: 20_000, attempts: [{ step: 'translation', reservedMicroCny: 20_000, outcome }] }))
    const before = readFileSync(join(dir, 'test-budget.json'), 'utf8'); expect(() => open(dir)).toThrow()
    expect(readFileSync(join(dir, 'test-budget.json'), 'utf8')).toBe(before)
  })
  it('poisons failed outcome persistence while keeping already durable money reserved', () => {
    const f = fixture(); f.ledger.reserve('translation')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('synthetic outcome failure') })
    expect(() => f.ledger.recordOutcome('translation', 'service_error', requestHash, 'transport')).toThrow()
    expect(f.ledger.failed).toBe(true); expect(f.ledger.reservedMicroCny).toBe(20_000)
    expect(() => f.ledger.reserve('ruby')).toThrow()
  })
  it('retains its owned lock after an uncertain outcome write even if no pending file was created', () => {
    const f = fixture(); f.ledger.reserve('translation')
    const original = fs.openSync
    const spy = vi.spyOn(fs, 'openSync').mockImplementation((file: unknown, ...rest: unknown[]) => {
      if (String(file).endsWith('.pending')) throw new Error('synthetic outcome open failure')
      return original(file, ...rest)
    })
    expect(() => f.ledger.recordOutcome('translation', 'usage_anomaly', requestHash, 'usage_anomaly', true)).toThrow()
    spy.mockRestore()
    expect(existsSync(join(f.dir, 'test-budget.pending'))).toBe(false)
    f.ledger.close({ retainLock: true })
    expect(existsSync(join(f.dir, 'test-budget.lock'))).toBe(true)
    expect(() => open(f.dir)).toThrow()
    expect(JSON.parse(readFileSync(f.file, 'utf8')).reservedMicroCny).toBe(20_000)
  })
  it('holds its exclusive file lock across another process and does not accept a new process after SIGKILL', async () => {
    const dir = directory(); initializeLedger(dir)
    const child = spawn(process.execPath, ['-e', `const {OneRmbTestLedger}=require(${JSON.stringify(modulePath)}); const l=new OneRmbTestLedger(${JSON.stringify(dir)}); l.reserve('translation'); process.stdout.write('ready\\n'); setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let error = ''
    child.stderr.on('data', chunk => { error += String(chunk) })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Synthetic child startup timeout')) }, 5000)
      child.once('error', err => { clearTimeout(timer); reject(err) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic child exit ${code}: ${error}`)) })
      child.stdout.once('data', () => { clearTimeout(timer); resolve() })
    })
    expect(() => open(dir)).toThrow()
    const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit
    expect(() => open(dir)).toThrow()
    expect(JSON.parse(readFileSync(join(dir, 'test-budget.json'), 'utf8')).reservedMicroCny).toBe(20_000)
    const second = spawnSync(process.execPath, ['-e', `try { new (require(${JSON.stringify(modulePath)}).OneRmbTestLedger)(${JSON.stringify(dir)}); process.exit(5) } catch { process.exit(0) }`])
    expect(second.status).toBe(0)
  })
})
