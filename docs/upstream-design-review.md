# Upstream design comparison and implementation queue

Review date2026-10-26; LingoBar baseline is frozen PR9
`fee6019c0909ef71a16cb16c56edefa9f00bb372`. This is a comparison of specific
official files/docs, not a claim that every repository was audited. No model,
SDK, dictionary, dependency or copied upstream implementation is introduced.
The implementation remains original CC BY-NC4.0 code. Provider protocols and
immediate partial translation remain in use; Cloudflare login does not gate
these independent code changes.

## Verified sources and licenses

| Reference | Verified license | Specific design reviewed |
| --- | --- | --- |
| [WhisperStreaming HypothesisBuffer](https://github.com/ufal/whisper_streaming/blob/6da90b44b7e50d79695e68166d2a2c7609c75abb/whisper_online.py#L359-L424), [README](https://github.com/ufal/whisper_streaming/blob/6da90b44b7e50d79695e68166d2a2c7609c75abb/README.md) | [MIT](https://github.com/ufal/whisper_streaming/blob/6da90b44b7e50d79695e68166d2a2c7609c75abb/LICENSE) | Confirmed versus temporary hypotheses, overlap removal and commitment. Its README recommends SimulStreaming as successor. Its word/token/timestamp overlap algorithm is not copied or treated as a CJK whitespace algorithm. |
| [SimulStreaming translation output](https://github.com/ufal/SimulStreaming/blob/077ea37d5ab4ff98bc567e4507f140dc4e5d5ad6/simulstreaming_translate.py#L501-L512), [README protocol](https://github.com/ufal/SimulStreaming/blob/077ea37d5ab4ff98bc567e4507f140dc4e5d5ad6/README.md) | [MIT](https://github.com/ufal/SimulStreaming/blob/077ea37d5ab4ff98bc567e4507f140dc4e5d5ad6/LICENCE.txt) | Confirmed `text` versus `unconfirmed_text`; processing `COMPLETE` is distinct from utterance `is_final`. No local model or replacement ASR is adopted. |
| [Able Player transcript](https://github.com/ableplayer/ableplayer/blob/3f174b22bd779e42db2959401f1bec003a5b2880/scripts/transcript.js#L129-L149) | [MIT](https://github.com/ableplayer/ableplayer/blob/3f174b22bd779e42db2959401f1bec003a5b2880/LICENSE) | Explicit auto-scroll control and distinction between reader scroll and programmatic scroll. This prompts a touch-reading audit; PR9 already handles Space keyboard review. |
| [asbplayer annotation guide](https://docs.asbplayer.dev/docs/guides/annotation/), [pinned project declaration](https://github.com/asbplayer/asbplayer/blob/ffab2456189994111c09fb813bb9b1aa6384f47e/README.md) | [AGPL-3.0-or-later](https://github.com/asbplayer/asbplayer/blob/ffab2456189994111c09fb813bb9b1aa6384f47e/LICENSE); some portions MIT, not the whole application | Per-word readings/status and separately configured annotation. Behavior reference only: no AGPL implementation, Yomitan, Anki integration or replacement of LingoBar's LLM ruby is included. |

## Current coverage — preserve rather than reimplement

| Design question | Existing LingoBar evidence | Decision |
| --- | --- | --- |
| Are recognized source, translated prefix and utterance final separate? | `Caption.original`, `translatedOriginal`, `live`, `translationPending`, `status`; shared `caption-queue.ts`, renderer `caption-text.ts`; `captions-live.test.ts` covers partials, corrected final and source/translation alignment. | Covered. Keep provider final immediately usable; no extra LocalAgreement delay or whitespace tokenization. |
| Can a late translation replace a newer revision or a new run? | Queue job object, revision/published/final gates, one current logical translation job per caption, captured targets; Qwen/Engine owner and namespaced provider IDs; `session-isolation.test.ts`, `captions-live.test.ts`, `worker-session.test.ts`. | Covered within retained IDs, except the long-session final-ID boundary below. Superseded transports can still settle after cancellation; job ownership/version checks suppress stale publication. A bounded browser-session replay of rev3/rev1/rev2, old partial after final, language cancellation and restart also passes. No redundant four-field public API is added. |
| Can stale ruby attach after retry, source change, timeout or close? | Annotation job identity, cancellation on replacement, exact Japanese binding; `captions.test.ts`, `captions-live.test.ts`, `japanese.test.ts`; exact segment concatenation/kana validation and25s timeout. A bounded synthetic comparison also confirmed two different source revisions yielding identical Japanese cannot accept the old job. | Covered. Preserve correct translated text when optional annotation fails. |
| Can readers search/review while updates arrive? | Stable history IDs/anchors, local source/translation search, selection pause, explicit Return to live, no per-partial live-region announcements; `history-search.test.ts`, browser UI regressions, PR9 Space checks. | Covered for tested inputs. Touch-driven scroll needs its own evidence; do not claim the keyboard fix covers iPhone. |
| Are annotation display and copied text independent? | Global `showFurigana`, ruby only in rendering, copy built from aligned source/translations; no kana injected into source text. | Covered. Annotation-only retry is a separate possible workflow improvement below. |

The session/revision/target-language guard recommendations are our engineering
deduction from the confirmed/temporary separation, not a claim that the upstream
projects implement LingoBar's Qwen/DeepSeek protocol or an identical guard schema.

## Prioritized work with acceptance criteria

| Priority / item | User benefit and current gap | Acceptance / state |
| --- | --- | --- |
| P0: keep finalized identity for the whole accepted session | Desktop Qwen silently evicts the oldest completed provider ID at257 finals. A late partial/final for that ID passes the same-session guard and can create a duplicate paragraph. Worker adapter shares that cache pattern, but its RelaySession has an additional non-evicting bounded guard. | **Reproduced and fixed in this batch**, details below. Replay first ID after257 finals in streaming and realtime; retain fresh IDs/stash; enforce exact bounded storage, visible failure on exhaustion, no automatic restart; explicit new owner may reuse provider IDs. |
| P1: touch reading versus programmatic following | Able Player's distinction suggests checking drag-scroll on the phone Web path. Existing LingoBar handlers explicitly cover wheel, selection, scrollbar pointer and navigation keys; source inspection alone does not prove touch behavior. | **Next independent validation**, not yet a confirmed defect. Actual browser touch events must scroll overflowing expanded/compact captions, preserve reading position during new partial/final/ruby updates and resume only explicitly; taps/copy/selection and programmatic following must remain correct. iPhone acceptance stays separate. |
| P1: annotation-only retry | Today `CaptionQueue.retry` reissues translation and optional annotation. A valid Japanese translation with failed ruby could benefit from retrying only ruby, preserving text and avoiding unnecessary translation requests. asbplayer motivates separate annotation control; the exact retry design is LingoBar-specific. | **Queued feature**, not implemented or an alleged current bug. Synthetic test: retry invokes only annotator for current aligned source/Japanese/owner, no translator or ASR call; once-only pending state; stop, revision/language change or timeout rejects late ruby; saving/copying and valid translation stay intact. Preserve existing LLM annotation and fair bounds. |

No broad per-word dictionary/learning module is committed to this queue. Its
data sources, privacy and workflow need a separate product decision. Existing
favorites, local history lookup and Markdown export are already present.

## P0 reproduction, implementation and limits

At the baseline, two desktop and two standalone Worker-adapter tests fail after
257 synthetic finals: replaying the first ID dispatches both a stale partial and
a duplicate final. The desktop Engine checks run ownership only; CaptionQueue
has already closed that utterance. This is a reproducible defensive boundary,
**not evidence that the real provider sends such a late replay**. The Worker
Relay's separate completed-ID guard already prevents this in its current bounded
sessions; adapter consistency is defense in depth.

`FinalizedUtterances` keeps exact opaque IDs without numerical ordering,
normalization, probabilistic false positives or silent eviction. Two explicit
engineering budgets bound this memory:16,384 IDs and1,048,576 UTF16 units for ID
strings (about2MiB string payload plus Set/entry overhead). These are application
safety limits, not provider quotas or an upstream recommendation. Repeated known
IDs consume no additional budget. This bounds final-ID memory, not every memory
allocation in the application.

When a new final would exceed either bound, the adapter reports a fixed error
and hard-ends the current session before dispatching that final. It never forgets
old IDs to continue. Desktop reports `本次识别记录已满，请重新开始。`; the Worker
uses the existing quota error category. Stop clears the tracker; only an explicit
new session can reuse IDs. Ordinary partial/final/stash scheduling is unchanged.
No automatic reconnect, model change, extra recognition agreement or API call
is introduced. Sessions without provider IDs retain their existing behavior;
the tracker cannot invent reliable identity for unlabelled events.

Focused tests cover the old257 boundary, exact opaque/out-of-order identity,
default maximum count, UTF16 size budget, known replay at capacity, both adapter
protocols, visible exhaustion, once-only cleanup and explicit stop/start owner
isolation. Tests inject small private limits to exercise exhaustion cheaply;
browser/server configuration cannot change these budgets. Full source, renderer,
Web/Worker and platform CI results belong to the exact commit in the draft PR.

All tests are synthetic. Native audio, paid services, deployed Workers CPU,
iPhone/Safari, hardware interruption and assistive-technology acceptance remain
unverified. No credentials, personal captions, audio recordings or user computer
are accessed. No login retry, Cloudflare resource, deployment, merge or Release
is performed in this review.
