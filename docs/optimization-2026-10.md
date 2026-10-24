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
`npm run test:media-permissions`. The browser suite now executes 58 checks at
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

## Next executable batch

Under sustained backlog, a queued draft can become outdated before dispatch if
new recognition arrives before its next coalescing timer. The published pair
stays correct, but that obsolete request can add cost and latency. Reproduce
with two blocked slots, queued draft A, newer A text and a slot release before
the timer; then refresh only the still-queued draft snapshot, preserving finals,
configuration snapshots, the per-caption throttle and cancellation. Validate
bounded concurrency, final fairness, 100 rapid revisions and stop/late callbacks
with synthetic providers before considering a change. This is an optimization
opportunity, not a claim of source/translation misalignment.
