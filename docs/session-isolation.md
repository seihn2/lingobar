# Late-response isolation checkpoint

This bounded check starts from PR3 `fad37beffb185ea9c5244bb0788ee73763d951e3`
and separately reviews draft PR4 `e1209b5de5b1d4984ee4d01943b943a0494cb39a`.
Both are based on main `857ec2c632b38b4ad50276be48524b2f8dc2571b`.
No new production defect reproduced, so no application code, protocol,
scheduling, timeout, dependency or capture behavior changes in this checkpoint.
PR3's production source tree remains
`84b50baf406f78f9e7414e553c1e077fd7f2e3a8`.

## Contract and existing coverage

Two different lifetimes matter. Audio events belong to one capture run and
provider session. Stopped/replaced/timed-out owners must not create or revise
captions, or change the current listening/error state. Translation and optional
furigana jobs belong to a retained caption and request revision. Pausing or
changing audio sources deliberately lets already recognized history finish
translating; that is useful history completion, not a new audio event.

| Boundary | Existing guard and regression |
| --- | --- |
| Old ASR socket / reused provider sentence ID | Qwen checks its live owner before receive/fail, invalidates it before terminate, and namespaces sentence IDs with a session UUID; [socket tests](../test/audio-qwen.test.ts) cover cancellation, late events and ID reuse |
| Old source / native helper / microphone IPC | AudioEngine callbacks close over a run owner; main start completion checks its generation and microphone PCM/ready/failed check the current run; [engine](../test/audio-engine.test.ts), [native](../test/audio-native.test.ts), [Windows helper](../test/audio-windows.test.ts) and [installed IPC](../test/ipc-runtime.test.ts) tests cover these boundaries separately |
| Corrected final / canceled translation | CaptionQueue checks job identity, abort state and published/final revisions; [live tests](../test/captions-live.test.ts) cover corrected finals, useful older prefixes, selected languages and final retry; [queue tests](../test/captions.test.ts) cover close and late success/failure |
| Translation / optional annotation deadline | The transport checks abort before parsing a late response; annotation also checks caption/job identity after its deadline/retry; [transport](../test/translation.test.ts) and [annotation queue tests](../test/captions.test.ts) preserve readable translations and reject stale readings |

The existing research and license decisions remain in
[the optimization record](optimization-2026-10.md#sources-licenses-and-decisions).
This check adds original LingoBar tests under CC BY-NC 4.0. It does not import,
copy or adapt an upstream implementation, add an automatic reconnect, or repeat
the earlier broad project research or performance experiments.

## New cross-layer regression

The existing installed-main fixture replaced AudioEngine and CaptionQueue with
mocks. The new [session-isolation test](../test/session-isolation.test.ts) keeps
the real installed main handlers, AudioEngine, Qwen session, CaptionQueue and
translation transport together. Only Electron/OS, storage, native capture,
socket creation and `fetch` are synthetic. Both streaming and realtime protocol
paths run the same six cases, for twelve checks:

- Begin with independent system and microphone captions, change source/device
  through the installed settings IPC, and start a fresh microphone run reusing
  provider sentence ID `1`. Old socket partial/final/error/close, native errors
  and the old microphone-run failure IPC leave the new snapshot unchanged.
- Complete one legitimate old history translation while the new caption exists;
  only that old caption changes. Then fail the current source and deliver the
  other old translation as either success or failure. The current listening
  error remains intact, and translations/errors stay with their caption IDs.
- Expire startup, restart, then send the old configuration acknowledgement and
  transcript/error/close events. Only the fresh session creates a caption.
- Invoke the actual pause IPC, let it settle, restart, and send old audio/error
  events. The old historical translation and resumed final stay separate. PR3
  stops immediately; a temporary PR4 combination instead reaches its bounded
  two-second drain deadline in this fixture. This tests isolation after that
  boundary, without treating the two pause behaviors as identical.
- Expire the real transport's 25-second timer, change sources and complete a new
  final. Settle the old request as either success or failure: its caption exposes
  the sanitized timeout, the new caption stays intact, and retry translates the
  old original successfully without changing the new final.

The fake fetch deliberately ignores abort until explicitly settled, exercising
the late-result guard. This does **not** measure real fetch abort latency or
claim that an uncooperative adapter settles at the deadline. Existing transport
tests separately check prompt rejection with an abort-aware fake. Every new
case ends with no pending timer; cleanup hard-stops capture, closes the queue
and rejects unfinished synthetic requests. No actual socket, capture helper,
device, user data, credential or billable provider is used.

## PR4 and validation limits

PR4 intentionally allows the current owner's already-sent audio to finish during
an explicit bounded pause. New input stops immediately; deadline, restart,
service-setting change, fault, permission revocation and quit invalidate the
owner. Its existing positive [pause tests](https://github.com/seihn2/lingobar/blob/e1209b5de5b1d4984ee4d01943b943a0494cb39a/test/audio-pause.test.ts)
check that tail acceptance and post-deadline rejection for both protocols.
This checkpoint does not replace pause-drain with blanket cancellation.

Run `npx vitest run test/session-isolation.test.ts` for this focused check, then
`npm test`, `npm run build`, `npm run test:ui` and
`npm run test:media-permissions` for the normal regression suite. Exact-head CI
and temporary PR3+PR4 combination results are recorded in PR3. A temporary merge
is only a test baseline, is discarded after testing, and produces no combined
package or main merge.

This is synthetic cloud validation. It does not extend the
[physical Mac record](macos-validation.md), establish real provider latency or
tail completeness, or count as Windows 10/11 hardware acceptance. Native IME,
assistive technology, window controls, actual system/microphone audio and online
translation remain subject to the existing platform validation limits. A
test/documentation-only head does not make the prior PR3 package include PR4.
