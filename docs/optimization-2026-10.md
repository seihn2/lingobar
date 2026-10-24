# Caption reliability and local history lookup

This small batch starts from merged `main` commit
`857ec2c632b38b4ad50276be48524b2f8dc2571b`. It preserves the existing
Windows/macOS audio paths, provider protocols and CC BY-NC 4.0 project license.
The changes below are original LingoBar code; no upstream implementation or
new dependency is included. Research sources were checked on 2026-10-24.

## Delivered changes and acceptance

| Change | User value | Acceptance |
| --- | --- | --- |
| Keep a failed final translation actionable after a late prefix succeeds | A queue overflow cannot hide recognized but untranslated words or the retry action | Fill both translation slots, evict the waiting final with 20 further jobs, resolve its older prefix: retain the original and useful prefix, error state and untranslated tail; saving stays disabled; a manual retry replaces it with a complete final and clears the error |
| Search retained history locally | Find a heard phrase or an existing translation without retranslating or scrolling through every segment | `Ctrl+F` / `Cmd+F` opens history from either window mode; normalized literal search covers source, last translated source and all existing languages; Enter / Shift+Enter cycle matches, a click opens that exact segment; 100 arrivals and a late matching translation retain the selected ID and visible reading anchor; IME, empty/cleared history, saved-only filtering, Unicode and HTML-like text are safe; Esc restores an existing invoking control |
| Update the merged project entry points | Readers reach the current main CI instead of an already-merged development branch | Three READMEs share the real main/push badge and current installation/development links; guides distinguish this source revision from older packages; PR #2 retains its original artifact provenance |

Tests use synthetic strings, fake sockets/translators and fake audio devices.
No microphone, personal subtitles, credentials or paid API is used. Search runs
entirely in the renderer, uses plain React text rendering and makes no IPC or
provider request. The query is not saved and is cleared when its panel closes.
It only searches retained local captions: not evicted entries, external files,
or unstarred sessions from a previous app run.

The history view tracks a matching **segment ID**, not a result index. A new
match can change the displayed count without choosing another segment. If the
selected segment is removed or no longer matches, the first remaining result
is selected. Reading anchors remain within the available scroll range; very
short lists can reach that range's boundary.

Keyboard review also found that the text-submit button blocked all key events
from reaching Find. Its propagation guard now applies only to Enter. Composition
state also blocks the existing typed-text submission shortcut, so confirming
an IME input cannot accidentally submit text to a provider. Browser regression
tests verify both focus positions and zero provider calls during composition.

## Sources, licenses and decisions

| Source | Verified license | What informed this batch / decision |
| --- | --- | --- |
| [Subtitle Edit Find](https://subtitleedit.github.io/subtitleedit/features/edit.html#find) and [command palette](https://subtitleedit.github.io/subtitleedit/features/command-palette.html) | [MIT](https://github.com/SubtitleEdit/subtitleedit/blob/cf1c3e3ba4e1a51f060daef5bce3b5f5a54dcdf0/LICENSE) | Behavior reference for searching original and translated subtitle text and keyboard access. LingoBar implements a smaller local literal finder; no editor, replace operation, regex engine or command-palette module is added. No code/assets copied. |
| WhisperLiveKit [processing queue](https://github.com/QuentinFuxa/WhisperLiveKit/blob/eb92c115ee7abc1e161b0b2159da31785b0f5566/whisperlivekit/processing_queue.py) and [diff protocol](https://github.com/QuentinFuxa/WhisperLiveKit/blob/eb92c115ee7abc1e161b0b2159da31785b0f5566/whisperlivekit/diff_protocol.py) | [Apache-2.0](https://github.com/QuentinFuxa/WhisperLiveKit/blob/eb92c115ee7abc1e161b0b2159da31785b0f5566/LICENSE) | Review prompts for bounded work and committed versus revisable text. LingoBar already has bounded/fair queues and revision guards; the concrete late-prefix/evicted-final bug was independently reproduced in LingoBar and fixed without replacing that scheduler. No code copied. |
| Buzz [device handling](https://github.com/chidiwilliams/buzz/blob/main/buzz/audio_devices.py) and [recording lifecycle](https://github.com/chidiwilliams/buzz/blob/main/buzz/transcriber/recording_transcriber.py) | [MIT](https://github.com/chidiwilliams/buzz/blob/main/LICENSE) | Parallel research into device recovery. LingoBar already ends an invalid source under one session owner. Automatic cross-device recovery is deferred; it must not restart recording after user stop. No code copied. |
| WhisperLive [client](https://github.com/collabora/WhisperLive/blob/main/whisper_live/client.py) | [MIT](https://github.com/collabora/WhisperLive/blob/main/LICENSE) | Parallel research into session cleanup/reconnect. No automatic reconnect is introduced: user stop, authentication failures, quota and transient failures need distinct behavior first. No code copied. |
| LunaTranslator [translation history](https://github.com/HIllya51/LunaTranslator/blob/main/src/LunaTranslator/gui/transhist.py) | [GPL-3.0](https://github.com/HIllya51/LunaTranslator/blob/main/LICENSE) | Behavior-only reference from parallel research for locating cached history instead of retranslating it. Its implementation is not incorporated. |
| asbplayer [annotation guide](https://docs.asbplayer.dev/docs/guides/annotation/) | [AGPL-3.0](https://github.com/asbplayer/asbplayer/blob/main/LICENSE) | Behavior-only research into reading and in-place configuration errors. No code is incorporated and no additional annotation feature is added in this batch. |

The permissive licenses do not replace the project license. GPL/AGPL source is
not copied, translated, vendored or linked into the application. Existing
third-party provenance remains in [NOTICE.md](../NOTICE.md).

## Existing behavior retained after review

- Drafts coalesce after a 650 ms initial delay and 1.1 s update interval; one
  caption has at most one running request. At most two translations and two
  optional annotations run concurrently, with bounded waiting queues.
- Draft/final scheduling already shares capacity fairly. Reliable provider
  finals are used immediately; no extra local-agreement delay is introduced.
- Request identity, revision, abort and audio-session ownership prevent old
  callbacks from overwriting current work. Source/translation pairs retain
  `translatedOriginal`, even when useful unfinished prefixes publish first.
- Added stress coverage sends 100 partial revisions across eight selected
  languages, then a final: one caption, two translation calls, no leftover timer.

## Verification and limits

Run `npm test`, `npm run build`, `npm run test:ui` and
`npm run test:media-permissions`. The original browser suite executes 58 checks at
each emulated scale 1 / 1.5 / 2, including local search and the existing reading,
furigana, transparency and compact-window regressions. The actual Electron
permission-chain suite still executes 25 checks with two fake devices and no
fake UI auto-grant switch. Windows/macOS packaging and native synthetic checks
run in the existing [desktop workflow](../.github/workflows/build.yml).

CI results and artifact checksums belong to their exact build commit in the
corresponding PR; this record does not equate them with Windows 10/11 hardware
acceptance. The installer remains unsigned, no formal release/auto-update is
published, and no user computer is accessed. Outstanding hardware and provider
acceptance is listed in [windows-validation.md](windows-validation.md).

## Backlog measurement

The proposed queued-draft refresh was subsequently measured in a
[reproducible offline comparison](draft-backlog-benchmark.md): 54 runs compare
the pinned baseline with snapshot-only and snapshot-plus-timer experiments.
Some cases catch up to current speech sooner with fewer requests, but others
delay the first readable prefix, final translation or newly selected language;
the snapshot-only variant can also duplicate a revision. Production scheduling
therefore remains unchanged. The report separates character/byte counts from
model tokens and billing, and records the full positive and negative results.

## Snapshot and IPC measurement

The [snapshot report](snapshot-benchmark.md) pins this PR's `c7d737b` source and
predeclares engineering budgets before collecting synthetic measurements.
It separates Node encoding/clone proxies from real Electron main IPC and the
production preload/contextBridge callback, across 0/150/1150 history entries,
1/3/8 languages and 5/20/60 partials per second. A benchmark-only single-publish
control is compared without changing `src/`. Ordinary reference traffic fits
the first matrix's budget; large-history pressure and shared-container tails
do not, and the control has negative cases. Four additional windows check
final/status/error observation without first draining pending partials.
All issued messages are counted; producer stalls are not labelled IPC loss.
The report retains these limits and all results instead of adopting a new
protocol on this evidence. No new dependency, external code, audio or API
call is introduced. This is Linux synthetic transport validation, not React
painting, provider/network latency or Windows/macOS hardware acceptance.

## Physical Mac evidence and visibility checkpoint

The [Mac validation record](macos-validation.md) now records the authorized
physical PR3 `796a1aa` synthetic-history checks, including search, reading,
opacity and archive verification, and separately lists uncertain/pending
visibility, native input and audio checks. It contains no private paths or
identities and makes no claim for PR4 or Windows hardware.

The reported visibility observation did not reproduce as a source defect.
Production hide/show code remains unchanged. Five installed-main-handler tests
cover trusted hide, security, active capture continuity, repeated shortcut
toggle, hidden partial/settings/stop updates and explicit redisplay inputs.
Four browser checks per scale use actual DevTools pointer input for expanded
and compact hide targets; the UI suite is now 62 per scale. These original
CC BY-NC 4.0 tests and the Electron API contract linked in the record support
routing checks only, not native Mac visibility acceptance. No third-party code
or new dependency is incorporated, and no further performance experiment is
added in this checkpoint.

## Panel focus and accessible selection

The next [bounded renderer regression](panel-accessibility.md) reproduced lost
focus when an invoking control/autofocus child was removed, focused language
removal, and missing current-state semantics. It captures a surviving workflow
origin before opening, restores only on close with a compact→expanded fallback,
keeps language-removal focus on a stable option, and exposes the existing
settings/history button states. Nine baseline failures become passing checks;
the browser suite is now 85 per scale, including actual AX-tree state and trusted
Tab events. Original code, no new dependency or external implementation, no
audio/provider changes and no user Mac execution. Physical/native assistive
technology acceptance remains separate.

## Late-response isolation checkpoint

A [bounded cross-layer audit](session-isolation.md) found no new reproducible
session-contamination defect. It adds synthetic coverage through the real main
handlers, Engine, Qwen session, caption queue and translation transport: source
and device changes, reused provider IDs, stale socket/native/microphone errors,
startup and translation deadlines, current-error preservation and retry of the
original historical caption. Useful old history translations may still finish
on their own caption IDs. Production source remains unchanged from `fad37be`;
PR4's bounded pause tail acceptance remains a separate, explicitly tested
contract. No reconnect, new provider call, copied upstream code or performance
experiment is introduced.
