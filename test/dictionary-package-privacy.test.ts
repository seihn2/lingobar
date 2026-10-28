import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
const { bundleInventory } = createRequire(import.meta.url)('../scripts/archive-macos.cjs')
it.each(['learning-v1.json', 'dictionary-learning-v1.json', 'dictionary-learning-v1.json.synthetic.tmp'])('rejects local study profile %s from app bundle inventory', name => {
  const directory = mkdtempSync(join(tmpdir(), 'dictionary-private-bundle-'))
  try { writeFileSync(join(directory, name), '{}'); expect(() => bundleInventory(directory)).toThrow('Profile/development file') }
  finally { rmSync(directory, { recursive: true, force: true }) }
})
