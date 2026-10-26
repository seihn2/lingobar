# Microphone termination during startup

This small reliability fix starts from frozen PR7 source
`c537788aba4c70f8eac382f703b89cf2970ed106`. Its diff changes only the shared
renderer microphone lifecycle, regression tests and this record. Desktop pause
drain in PR4 remains independent; no audio-engine, ASR, translation, authentication,
Workers deployment, startup/login-item policy or UI behavior is redesigned.

## Reproduced gap

`startMicrophone` previously assigned audio-track `onended` handlers only after
awaiting the AudioWorklet module. It also did not inspect a newly acquired track's
`readyState`. An already-ended grant could report startup success. An end event
during module loading was missed; during pending `AudioContext.resume`, cleanup
ran but the startup promise did not settle until resume resolved or the30s
startup deadline elapsed.

Three synthetic regressions fail on the parent implementation: an ended grant
returns success, and interruptions during delayed module/resume leave startup
pending instead of rejecting immediately. The fixture exposes the actual production
function to controlled track state/events and deferred Web Audio promises. It
uses no microphone, recording, network, personal subtitle or provider key. This
demonstrates a JavaScript lifecycle defect, not a physical unplug reproduction.

## Change and acceptance

Track termination is owned immediately after acquiring the stream, before the
first audio-graph await. Ended/empty grants are rejected without constructing an
AudioContext. Before startup completes, termination releases resources and rejects
the startup promise with the existing disconnection message; it does not also
emit the active-capture error callback. After startup, the existing active error
callback remains once-only. The track state is checked again after resume.

Acceptance uses the existing microphone fixture and fake clocks:

- Already-ended grant: immediate rejection, no AudioContext, tracks released once,
  no pending timer and no second error callback.
- End during worklet loading or resume: immediate rejection while the operation
  remains unresolved; later continuation cannot report success, produce PCM or
  allocate a delayed worklet after cleanup. Context/track cleanup occurs once.
- End after startup: one existing error callback, no subsequent PCM, and repeated
  end/stop calls do not repeat cleanup.

The original resampling, permission/late-grant cancellation, selected/default
device behavior and fresh explicit restart tests remain. Full Web/Worker tests
also exercise the unchanged browser session and selected-language caption paths.

## Design references and license

[LiveKit's client SDK LocalTrack](https://github.com/livekit/client-sdk-js/blob/da86e21501bc30d1dc92486316fe0040da69a522/src/room/track/LocalTrack.ts#L162-L195)
installs track termination listeners before subsequent asynchronous processing.
Its pinned [Apache-2.0 license](https://github.com/livekit/client-sdk-js/blob/da86e21501bc30d1dc92486316fe0040da69a522/LICENSE)
was checked on2026-10-26. The useful design is early lifecycle ownership;
LingoBar does not adopt LiveKit's processor/restart architecture or add its SDK.
No code, comment or asset was copied. The change is original CC BY-NC4.0 code.

The W3C [Media Capture track lifecycle](https://www.w3.org/TR/mediacapture-streams/#life-cycle)
defines terminal track state and the `ended` event for source/permission termination;
explicit application `track.stop()` does not fire that event. Tests therefore
distinguish simulated external end events from application cleanup. This is an
API-contract reference under the specification's linked W3C document license,
not incorporated specification text.

## Verification boundaries

Run `npx vitest run test/audio-microphone.test.ts`, `npm test`, `npm run build`,
`npm run build:web`, `npm run verify:web`, `npm run test:web-ui`,
`npm run test:ui` and `npm run test:media-permissions`. Exact CI heads, terminal
results and artifact provenance belong in the corresponding draft PR.

The regression is synthetic; browser UI and actual Electron fake-device permission
checks are separate layers. Native macOS/Windows unplug/permission revocation,
iPhone/Safari AudioWorklet activation and interruptions, and actual Workers/provider
behavior have not been validated by this fix. Cloudflare authentication and
deployment remain untouched. No user computer, secret or billed service is used.
