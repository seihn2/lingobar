# Annotation-only retry contract

Baseline: frozen PR11 `7beb3be7683fe7b699f0bba5037e847d6b1a1812`.
Existing `retry` invokes translation and then optional Japanese annotation.
Annotation failure already preserves a valid translation, but there is no
annotation-only retry path. This batch adds one explicit user action.

- Desktop: trusted `lingo:retry-annotation` accepts only a caption ID. The main
  caption queue owns the current source/Japanese snapshot and reuses its existing
  bounded annotation slots and 25s deadline. It never calls translator or audio.
- Web: explicit POST to same-origin HTTPS `/api/annotation`, JSON only, 64KiB
  maximum. `WEB_ENABLED` remains off by default. Required translation secret and
  internal `AUTH_SERVICE` verifier stay server-side; no ASR key/connection/audio
  is needed. The verifier must explicitly authorize this path and enforce its
  account-wide policy; this does not implement or configure a login service.
- Requests bind version 1, request ID, text-operation session ID, local caption ID,
  positive source revision and fixed language `ja`, plus the aligned original
  and Japanese text. No provider URL/model/key, audio or extra field is accepted.
  Responses echo only the identity and validated reading/segments. Segments must
  reconstruct the exact requested Japanese and place kana on corresponding kanji.
- The browser owns at most two text requests, suppresses duplicate pending retry,
  and rejects stale ownership/revision/source/Japanese/language responses. Stop,
  restart, language/annotation changes, row replacement/eviction, page hiding and
  disposal cancel outstanding manual requests; none starts or resumes capture.
- Worker text requests have a 30s overall bound and two concurrent slots per
  isolate. Existing completion/annotation 25s transport and at most two validation
  attempts are reused. Errors are fixed codes, never raw provider bodies. Actual
  cross-isolate/account limits remain the verifier's responsibility.
- Failure/cancellation changes only annotation state. Original, translations,
  history position and favorites remain intact. No automatic paid-service retry
  is added; tests use synthetic transports and audio/provider traps only.

There is no new external permission, resource, credential, SDK or deployment.
The implementation follows the original project license and behavior-only
research in [the comparison queue](upstream-design-review.md). Actual provider,
Workers CPU/runtime, native hardware and iPhone/Safari/VoiceOver are unverified.
Exact test results and final source/artifact provenance will be recorded in the PR.

## Acceptance evidence

Executed in this batch's isolated Linux cloud checkout, with installed project
dependencies and synthetic fixtures only:

| Layer | Verified result |
| --- | --- |
| Core + main/preload contract | 642 Vitest tests and 7 reading-schedule tests passed. Includes 10 annotation queue tests, strict annotation protocol, and trusted installed IPC/stop/settings regressions |
| Browser request/session | 16 new tests passed: paused history, duplicate/two-slot bounds, six cancellation paths with late success/failure, strict identity/ruby/UTF8/64KiB, timeout and response-body cleanup |
| Worker route | 40 new tests passed: default denial, same-origin path authentication, no ASR secret access, bounds/timeout/cancellation, fixed provider errors and exact identity/segments |
| Desktop renderer | 135 checks at each Chromium scale 1/1.5/2 (405 total), including both annotation actions, pending focus, failure/retry/success focus, selected languages/ruby and prior regressions |
| Web renderer | 57 checks at 375x812/scale1, 390x844/scale2, 860x560/scale1 (171 total), including paused annotation, deduplication, fixed error feedback, pagehide/late reply, existing native Chromium touch/reading checks |
| Build inspection | Desktop build/typecheck; static Web backend=null and Worker WEB_ENABLED=0 builds and verifiers passed. No runtime/dependency/workflow installation or deployment |

The actual Linux Electron 43.8.3 / Chromium 150 fake-device permission chain
passed 25 checks (no fake UI grant). Windows/macOS package CI is tracked against the final commit in the draft PR. Those checks do not
validate real microphones, actual provider accuracy/cost, deployed Workers CPU,
iPhone Safari/VoiceOver, or physical Windows/macOS hardware. The stack includes
PR3 and PR6–11; independent PR4 pause drain and PR5 timing work are excluded.
