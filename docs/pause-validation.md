# Bounded final recognition on explicit pause

This independent batch is based on main `857ec2c632b38b4ad50276be48524b2f8dc2571b`.
It does **not** contain the separate local-search/final-overflow changes in
[draft PR #3](https://github.com/seihn2/lingobar/pull/3). Neither PR is merged
by this work. Always match a test package to its exact build commit.

## Reproduction and value

Previously, `stop()` immediately invalidated the ASR owner and terminated its
socket. Both fake Streaming and Realtime transports reproduce that a final
arriving after stop is ignored, while the latest received partial survives.
This establishes the cancellation behavior, not actual word loss on a real
provider or audio device. The new explicit pause gives an already-ready session
a bounded opportunity to finish that same utterance.

## Protocol and implementation

| Path | Device and session behavior |
| --- | --- |
| Explicit pause after listening begins | Immediately stop system capture and microphone tracks, revoke the microphone run/recording permission, and reject new PCM. Wait at most 2 seconds for already-submitted audio results. Publish returned partial/final results under their existing utterance IDs; only after finish/timeout finalize remaining drafts. |
| Timeout | Close the connection, retain and translate the last received partial, show a paused/timeout notice. Never reconnect or resume recording. |
| Starting / permission prompt | Hard cancel immediately; do not wait or send a finish event. Late grants still release their tracks. |
| Quit, errors, permission revocation, device/service changes, new start | Hard cancel current sessions and the finish deadline. Old completion must not finalize or alter the new run. |
| Both sources | Stop both devices immediately and finish both sessions concurrently; the wait is bounded per session, not added sequentially. A recognition error on either source still cancels both. No silent one-source fallback is added. |

The 2-second value is an application wait budget, **not** a measured provider
latency guarantee or a deadline for translation/furigana requests. Audio already
queued in the transport before pause can still be delivered; no new PCM is
accepted after pause begins.

The official protocol references were read on 2026-10-24:

- [Qwen-Audio-ASR-Streaming client events](https://help.aliyun.com/en/model-studio/qwen-audio-asr-streaming-client-events): send `finish-task` with the existing task ID, duplex mode and empty input; accept the matching `task-finished` completion.
- [Qwen-ASR-Realtime client events](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-client-events): VAD recognition uses `session.finish` and `session.finished`. Do not add a manual `input_audio_buffer.commit` in VAD mode.

No upstream source implementation or new dependency is copied. This is original
LingoBar code under the existing CC BY-NC 4.0 project license. External model
review suggested an audit direction; it did not execute these tests or establish
protocol correctness. Only the official protocol references and reproduced
local behavior inform this implementation.

## Acceptance and synthetic evidence

| Area | Check |
| --- | --- |
| Old hard-stop baseline | Both protocol fixtures ignore post-stop finals and send no finish request/new PCM. |
| Protocol finish | Correct event shape/task ID, real final delivery before completion, empty final, wrong completion/task ignored, no manual VAD commit. |
| Bounds and cleanup | Default 2-second and injected deadlines, duplicate/shared finish promise, stop/start replacement, startup cancellation, close/error/send failures, synchronous teardown callbacks; no surviving finish timer or transport. |
| Device owner | Immediate stop and PCM rejection, both sessions finishing concurrently, both-source failure unchanged, new owner immune to old completion. |
| Production IPC handlers | Immediate recording permission rejection, run-bound PCM rejection, deferred draft finalization, duplicate pause, new start, settings change, permission failure, quit and stale completion. |
| Real Qwen session + engine + caption queue | Both protocols retain a post-pause final in the original caption ID; timeout finalizes the latest partial; late final is ignored after deadline. Only synthetic text and fake sockets/translators. |
| UI | Pausing button blocks repeat actions while waiting; final updates the existing paragraph; timeout confirms audio stopped and recognized content retained. Existing reading/ruby/opacity/compact regressions retained. |

Run `npm test`, `npm run build`, `npm run test:ui` and
`npm run test:media-permissions`. The unchanged desktop workflow also checks
Windows x64/macOS arm64 packaging, helper synthetic lifecycle and actual fake-device
Electron permission handling. This batch's browser suite has 32 checks at each
emulated scale 1 / 1.5 / 2. PR #3 separately has its full 58-check search suite;
it is not replaced by this independent branch's suite.

No real audio, personal captions, real credentials or paid API was used. Numeric
diagnostics remain under the existing local, time-limited opt-in mechanism;
finish timing/result events must contain no subtitle text, audio, keys, URL or
raw provider error.

Windows installers remain unsigned. CI is not Windows 10/11 or macOS audio
hardware acceptance, and no actual end-to-end provider latency/accuracy is
claimed. Hardware limits remain in [windows-validation.md](windows-validation.md).
Exact CI, head, installer artifact and SHA-256 are recorded in the corresponding
draft PR after the run reaches a terminal state. No merge or formal release is
performed.

## Follow-up: scope pause messages to their capture run

The follow-up starts from PR #4 head
`4cc3e0ba50900f79a98cc7f25f480a321c48c5e0`. A synthetic Chromium cross-review
reproduced this sequence: pause, open history before the reply, receive a timeout,
restart through a tray-style snapshot, then receive a new capture error. The old
timeout remained in the history panel and obscured the new failure. No actual
tray, audio device or provider was used in that reproduction.

The renderer now invalidates an old pause message when a new run or new capture
error arrives; delayed pause success and rejection replies also check that capture epoch. Compact,
expanded and panel views share the same current message fallback. Repeated
snapshots of an unchanged capture error preserve a newer local action error,
such as a failed copy, so this correction does not hide later user actions.
This is an original LingoBar correction under the existing license, based on
local review rather than copied upstream code. Audio/IPC permissions and the
recognition finish protocol are unchanged.

Nine additional browser assertions cover restart/error visibility, an open
history panel, a late pause reply, compact mode and newer local errors. The
standalone suite has 41 checks at each emulated scale. This follow-up contains
PR #4; it does not silently add PR #3's separate local-search feature. Combined
validation is reported with its exact parent heads in the PR.
