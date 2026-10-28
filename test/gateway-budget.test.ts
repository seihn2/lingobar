import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DailyBudget } from '../src/gateway/budget'
import { configuration, now } from './gateway-fixture'

const directories: string[] = [], open: DailyBudget[] = []
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'lingobar-synthetic-budget-')); directories.push(dir); return dir }
const budget = (dir: string, sessions = 1, requests = 42, clock = () => now) => { const value = new DailyBudget({ ...configuration(dir), dailySessions: sessions, dailyCompletionRequests: requests }, clock); open.push(value); return value }
afterEach(() => { for (const value of open.splice(0)) value.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe.skipIf(process.platform !== 'linux')('Linux private daily reservations, no captions or identity persistence', () => {
  it('reserves full session and annotation attempts before use, survives restart, and does not refund early stop', () => {
    const dir = directory(), first = budget(dir)
    first.reserve('session'); first.close()
    const second = budget(dir); second.reserve('annotation')
    expect(() => second.reserve('annotation')).toThrow('quota'); expect(() => second.reserve('session')).toThrow('quota')
    expect(JSON.parse(readFileSync(join(dir, 'budget.json'), 'utf8'))).toEqual({ version: 1, day: '2026-10-28', sessions: 1, completions: 42 })
    expect(statSync(join(dir, 'budget.json')).mode & 0o777).toBe(0o600)
  })
  it('blocks a second writer and fails closed on corruption or unsafe file permissions', () => {
    const dir = directory(), first = budget(dir)
    expect(() => budget(dir)).toThrow(); first.close()
    writeFileSync(join(dir, 'budget.json'), '{invalid')
    expect(() => budget(dir)).toThrow('Gateway budget unavailable')
  })
  it('rolls to the next UTC day without resetting early; clock rollback closes use', () => {
    let time = now
    const value = budget(directory(), 1, 40, () => time)
    value.reserve('session'); expect(() => value.reserve('session')).toThrow('quota')
    time += 86_400_000; value.reserve('session')
    time -= 86_400_000; expect(() => value.reserve('annotation')).toThrow('unavailable')
  })
  it('a persistence failure forbids upstream authorization and all later reservations, without silent in-memory fallback', () => {
    const dir = directory(), value = budget(dir)
    writeFileSync(join(dir, 'budget.pending'), 'synthetic interrupted writer', { mode: 0o600 })
    expect(() => value.reserve('session')).toThrow('unavailable'); expect(() => value.reserve('annotation')).toThrow('unavailable')
    expect(JSON.parse(readFileSync(join(dir, 'budget.json'), 'utf8')).sessions).toBe(0)
  })
})
