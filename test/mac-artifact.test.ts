import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { bundleInventory, commitSha } = createRequire(import.meta.url)('../scripts/archive-macos.cjs')
let directory: string, app: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'lingobar-mac-archive-test-'))
  app = join(directory, 'LingoBar.app')
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
  writeFileSync(join(app, 'Contents/MacOS/LingoBar'), 'Synthetic executable fixture; never run.', { mode: 0o755 })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('macOS artifact integrity inventory', () => {
  it('requires an immutable full commit rather than a branch or injected command', () => {
    expect(commitSha('A'.repeat(40))).toBe('a'.repeat(40))
    for (const value of ['', 'main', '36195e3', 'x'.repeat(40), 'a'.repeat(40) + '; echo unsafe'])
      expect(() => commitSha(value)).toThrow('immutable commit')
  })
  it('detects changed bytes even if the file size is unchanged', () => {
    const before = bundleInventory(app)
    writeFileSync(join(app, 'Contents/MacOS/LingoBar'), 'synthetic executable fixture; never run.')
    expect(bundleInventory(app)).not.toEqual(before)
  })
  it('rejects profile, credential and audio paths before they can be archived', () => {
    for (const name of ['settings.json', 'saved.json.tmp', '.env.local', '.npmrc', 'synthetic.wav', 'synthetic.key']) {
      const path = join(app, name)
      writeFileSync(path, 'Non-personal forbidden-path fixture')
      expect(() => bundleInventory(app)).toThrow(/Profile|Sensitive/)
      rmSync(path)
    }
  })
  it.skipIf(process.platform === 'win32')('detects execute-bit loss on an otherwise identical copy', () => {
    const copy = join(directory, 'copied.app')
    cpSync(app, copy, { recursive: true })
    expect(bundleInventory(copy)).toEqual(bundleInventory(app))
    chmodSync(join(copy, 'Contents/MacOS/LingoBar'), 0o644)
    expect(bundleInventory(copy)).not.toEqual(bundleInventory(app))
  })
  it.skipIf(process.platform === 'win32')('retains internal relative symlinks and rejects escapes from the bundle', () => {
    const path = join(app, 'Contents/Current')
    symlinkSync('MacOS', path)
    expect(bundleInventory(app)).toContainEqual(expect.objectContaining({ path: 'Contents/Current', type: 'symlink', target: 'MacOS' }))
    rmSync(path)
    symlinkSync(directory, path)
    expect(() => bundleInventory(app)).toThrow('External bundle symlink')
  })
})
