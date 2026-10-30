# Web audio + text: incremental test guard (not yet real-service validated)

Baseline: PR19 `1e79b852435869e3497486a3564833c4a4ea44ac`. Both
`WEB_ENABLED=1` and `WEB_TEXT_ENABLED=1` are now supported. Existing text keys,
Access-owner identity checks and the original text ledger remain unchanged.
No desktop changes, live deployment, microphone capture or paid API calls were
performed by this patch.

## Owner setup

Deploy matched `dist/web` and `dist/gateway` builds. Preserve existing Access,
Host/Origin forwarding and the ORIGINAL `GATEWAY_TEXT_LEDGER_DIRECTORY`.
Add exact same-origin gateway routing for `/api/settings/asr-key` (GET/POST)
and `/api/audio-annotation` (POST), retaining all existing routes. The new key
route verifies the same owner Access JWT; it accepts only `{apiKey}`, writes
server-selected private 0600 JSON atomically, never returns the key, and does
not test the key against the provider. Use `ASR_API_KEY_FILE` pointing to a new
file in the existing private credentials directory. This is a DashScope Beijing
API key, not an NLS AppKey. Never put it in chat, source, public config or logs.

For mixed setup set `ASR_MODEL=qwen3-asr-flash-realtime`, existing daily counters,
and `GATEWAY_AUDIO_LEDGER_DIRECTORY` to a separate private persistent directory.
The operator initializes its `audio-budget.json` ONCE, before starting gateway:

```json
{"version":1,"batch":"lingobar-audio-test-2026-10-30","reservedMicroCny":0,"attempts":0}
```

Directory 0700, file 0600, same already-authorized gateway identity. Never replace
an existing ledger, reset it across days/restarts, copy the old text ledger, or
clear a lock without establishing that no process still owns it. Missing,
corrupt, nonprivate or concurrently locked ledgers fail closed. Any required
VM write allowlist or permission change remains a deployment action for approval.

## Why real audio remains disabled

`audio-policy.ts` has `verified:false`. This is specifically the owner's NEW
<= CNY1 audio test guard, not a blanket policy for future users' independently
funded BYOK sessions. No environment/browser flag silently certifies pricing.
A reviewed policy/evidence update is needed before paid testing. Key saving is
still usable. Public status distinguishes missing keys, disabled audio, unverified
budget and quota. The browser never starts capture automatically after key save.

Official checks on 2026-10-30:
- [Pricing](https://help.aliyun.com/zh/model-studio/model-pricing): 3.1 streaming
  costs CNY6/M input + CNY4.5/M output tokens, NOT a per-second model.
- 3.0 streaming and qwen3 realtime: CNY0.00033/input audio second, output free.
- [Realtime guide](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)
  confirms Beijing support. Existing `dashscope.aliyuncs.com` remains supported.
- The published material does NOT establish minimum billable duration, partial
  second rounding or abnormal disconnect billing for these realtime models.
  Ten-second PCM bounds and a nominal 3300 micro-CNY quote therefore do not yet
  constitute a certified monetary upper bound. The code cannot dispatch ASR or
  associated translations under this unverified policy.
- [Free-quota stop mode](https://help.aliyun.com/zh/model-studio/savings-plan-and-resource-package)
  offers an alternative: safely verify the applicable provider model/account is
  configured to stop when free quota ends, guaranteeing no subsequent pay-as-you-go
  charge. Merely having free quota is insufficient. Do not change provider settings
  from this build or assume they are enabled. A deployment reviewer can record that
  evidence, then update the reviewed policy accordingly (ASR charge bound zero).

## Wired limits and accounting

The gateway caps PCM16/16kHz/mono input at 320000 bytes (10 seconds), and the
session at 30 seconds including setup. Limits apply server-side before forwarding.
Every actual ASR connection attempt and completion request must durably reserve
before dispatch. Retries reserve again; cancellation, failure, timeout, uncertain
outcomes and restart never refund. The new ledger stops at 1000000 micro-CNY
across all requests, not per day. Daily counts remain only secondary abuse limits.

Audio-session translation and ruby, plus paused audio-caption ruby retries at
`/api/audio-annotation`, use this NEW batch. Text submissions and text-caption
ruby remain on the OLD ledger. Every DeepSeek request uses the existing exact
shape/token-bound validator, including formatting retries. Its fixed model, text
only request, output cap and integer prices remain the previous proof conditions;
no old money is reclaimed. The reservation is not a reported supplier charge.

## Verification / handoff

Tests use generated Access signatures, loopback websocket transport and synthetic
provider replies; a synthetic policy is explicitly mocked only in tests. Passing
mock recognition/translation does not verify a key, audio quality, actual billing,
phone microphone behavior or deployment. Build/verify scripts must be run before
handoff. No PR merge, release or deployment is implied by a draft PR.

After matched deployment, first check anonymous/forged requests are denied and
owner key GET returns only `configured`. Confirm text still works within its old
budget. Only after safe key entry and verified cost protection may the deployment
worker execute a finite synthetic-audio test (no user mic by default), then confirm
real ASR text, real translation, the accumulated new ledger and provider outcome.
If evidence is missing, stop at `budget-unverified` rather than claiming live audio.
