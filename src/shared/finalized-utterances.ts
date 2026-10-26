export interface FinalizedLimits { maxIds: number; maxUnits: number }
// Exact opaque IDs belong to one ASR session. Never evict a finalized ID and
// silently accept its replay; the caller must end the session on exhaustion.
export const FINALIZED_LIMITS: Readonly<FinalizedLimits> = Object.freeze({ maxIds: 16_384, maxUnits: 1_048_576 })

export class FinalizedUtterances {
  private ids = new Set<string>()
  private units = 0
  private readonly limits: FinalizedLimits
  constructor(limits: Readonly<FinalizedLimits> = FINALIZED_LIMITS) {
    if (![limits.maxIds, limits.maxUnits].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid finalized-utterance limits')
    this.limits = { ...limits }
  }
  has(id: string): boolean { return this.ids.has(id) }
  remember(id: string): boolean {
    if (this.ids.has(id)) return true
    if (this.ids.size >= this.limits.maxIds || id.length > this.limits.maxUnits - this.units) return false
    this.ids.add(id); this.units += id.length
    return true
  }
  clear(): void { this.ids.clear(); this.units = 0 }
}
