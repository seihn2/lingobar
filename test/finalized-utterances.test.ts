import { describe, expect, it } from 'vitest'
import { FinalizedUtterances, FINALIZED_LIMITS } from '../src/shared/finalized-utterances'

describe('exact session-owned finalized ID memory', () => {
  it('retains opaque out-of-order IDs without numeric or normalization assumptions; full replays consume nothing', () => {
    const ids = new FinalizedUtterances({ maxIds: 3, maxUnits: 100 })
    for (const id of ['item-9', 'item-1', '項目-2']) expect(ids.remember(id)).toBe(true)
    expect(ids.remember('item-9')).toBe(true); expect(ids.remember('item-3')).toBe(false)
    for (const id of ['item-9', 'item-1', '項目-2']) expect(ids.has(id)).toBe(true)
    expect(ids.has('item-3')).toBe(false); ids.clear(); expect(ids.has('item-9')).toBe(false); expect(ids.remember('item-3')).toBe(true)
  })
  it('bounds exact UTF16 storage including combining characters/emoji, independently of ID count', () => {
    const limits = { maxIds: 100, maxUnits: 4 }, ids = new FinalizedUtterances(limits)
    limits.maxUnits = 100
    expect(ids.remember('👩')).toBe(true); expect(ids.remember('e\u0301')).toBe(true)
    expect(ids.remember('👩')).toBe(true); expect(ids.remember('x')).toBe(false)
    expect(ids.has('e\u0301')).toBe(true); expect(ids.has('é')).toBe(false)
    ids.clear(); expect(ids.remember('abcd')).toBe(true); expect(ids.remember('x')).toBe(false)
  })
  it('never silently evicts at the full production ID-count boundary', () => {
    const ids = new FinalizedUtterances()
    for (let i = 0; i < FINALIZED_LIMITS.maxIds; i++) expect(ids.remember(`item-${i}`)).toBe(true)
    expect(ids.remember('over-budget')).toBe(false); expect(ids.has('item-0')).toBe(true); expect(ids.remember('item-0')).toBe(true)
  })
})
