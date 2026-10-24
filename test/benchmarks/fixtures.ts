import type { AudioSource } from '../../src/shared/types'
import type { TargetLanguage } from '../../src/shared/languages'

export const firstText = 'Live focus: synthetic seed'
export const latestText = firstText + ' 語学学習𠮷 café'.repeat(24)
export const eightTargets: TargetLanguage[] = ['en', 'zh', 'ja', 'fr', 'de', 'ko', 'es', 'ar']

export type FixtureEvent =
  | { at: number; op: 'blocker'; name: string; duration: number }
  | { at: number; op: 'partial'; text: string; focus?: boolean; source?: AudioSource; utterance?: string }
  | { at: number; op: 'final'; text: string }
  | { at: number; op: 'history'; text: string }
  | { at: number; op: 'config'; targets: TargetLanguage[] }
  | { at: number; op: 'close' }

export interface Fixture {
  id: string
  label: string
  targets: TargetLanguage[]
  fixedServiceMs: number
  events: FixtureEvent[]
  horizon: number
  control?: boolean
  fairnessAt?: number
  ignoreAbort?: boolean
  checkSnapshot?: boolean
}

const partials: FixtureEvent[] = [
  { at: 0, op: 'partial', text: firstText, focus: true },
  { at: 700, op: 'partial', text: latestText, focus: true },
]
const final: FixtureEvent = { at: 6000, op: 'final', text: latestText + '.' }
const blockers = (duration: number): FixtureEvent[] => [
  { at: 0, op: 'blocker', name: 'blocker-one', duration },
  { at: 0, op: 'blocker', name: 'blocker-two', duration },
]

export const fixtures: Fixture[] = [
  {
    id: 'no-backlog', label: 'No backlog control', control: true,
    targets: ['en'], fixedServiceMs: 300, horizon: 15000,
    events: [...partials, final],
  },
  ...[750, 1200].map(duration => ({
    id: `blocked-${duration}`, label: `Two blockers until ${duration}ms`,
    targets: ['en'] as TargetLanguage[], fixedServiceMs: 300, horizon: 15000,
    checkSnapshot: true, events: [...blockers(duration), ...partials, final],
  })),
  {
    id: 'final-during-service', label: 'Final arrives while the first draft is still running',
    targets: ['en'], fixedServiceMs: 300, horizon: 15000, checkSnapshot: true,
    events: [...blockers(1200), ...partials, { at: 1400, op: 'final', text: latestText + '.' }],
  },
  {
    id: '100-partials-8-targets', label: '100 partials / eight targets / slow service',
    targets: [...eightTargets], fixedServiceMs: 1500, horizon: 30000, checkSnapshot: true,
    events: [
      ...blockers(2500),
      ...Array.from({ length: 100 }, (_, index): FixtureEvent => ({
        at: index * 20, op: 'partial', focus: true,
        text: 'Live focus: ' + '語学𠮷 café '.repeat(index + 1),
      })),
      { at: 12000, op: 'final', text: 'Live focus: ' + '語学𠮷 café '.repeat(100).trimEnd() + '.' },
    ],
  },
  {
    id: 'final-fairness', label: 'Final/history fairness behind two blockers',
    targets: ['en'], fixedServiceMs: 300, horizon: 15000, fairnessAt: 1000, checkSnapshot: true,
    events: [
      ...blockers(1000), ...partials,
      { at: 0, op: 'partial', source: 'microphone', utterance: 'aux', text: 'Aux synthetic partial' },
      { at: 700, op: 'history', text: 'History synthetic final' }, final,
    ],
  },
  {
    id: 'configuration-snapshot', label: 'Queued config snapshot survives later settings',
    targets: ['en'], fixedServiceMs: 300, horizon: 15000, checkSnapshot: true,
    events: [...blockers(1200), partials[0], { at: 675, op: 'config', targets: ['fr'] }, partials[1], final],
  },
  {
    id: 'cancel-cooperative', label: 'Close cancels waiting and running work',
    targets: ['en'], fixedServiceMs: 300, horizon: 15000, checkSnapshot: true,
    events: [...blockers(750), ...partials, { at: 800, op: 'close' }],
  },
  {
    id: 'cancel-late-result', label: 'Late result after close cannot publish',
    targets: ['en'], fixedServiceMs: 300, horizon: 15000, checkSnapshot: true, ignoreAbort: true,
    events: [...blockers(750), ...partials, { at: 800, op: 'close' }],
  },
]

export const models = [
  { id: 'fixed', label: 'Fixed duration', formula: 'fixture.fixedServiceMs; blockers use their explicit release time' },
  { id: 'length-sensitive', label: 'Length-sensitive duration', formula: '180 + 4 × source UTF-16 units + 15 × selected target count, in ms; blockers keep explicit release time' },
] as const
