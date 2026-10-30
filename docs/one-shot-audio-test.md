# One manually confirmed synthetic-audio test (not a website unlock)

This standalone CLI is intentionally independent of the website's fail-closed ASR
policy and future public BYOK/account work. It does not change Access, proxy routes,
services, provider settings, or any browser capability. No real provider test was
performed while implementing it. It never records a microphone or downloads audio.

## Scope and budget interpretation

The user's NEW approval is at most CNY1 for audio recognition plus its translation.
Before any outbound request, this runner locks the SAME `audio.lock` and reserves
ALL 1,000,000 micro-CNY from the existing `audio-budget.json` batch
`lingobar-audio-test-2026-10-30`. It refuses any nonzero prior reservation OR attempt,
missing/invalid ledger, existing lock, unsafe input, or missing explicit execution
confirmation. Do not create a fresh batch, reset, refund, or remove the ledger to
retry. The old `test-budget.json` / original text allowance is never used.

Published conditional calculation (2026-10-30):

- qwen3-asr-flash-realtime Beijing: <=10 seconds × CNY0.00033/s = CNY0.0033.
- DeepSeek: full input bound <=8192 tokens × CNY2/M plus output cap1024 × CNY8/M
  = CNY0.024576.
- Combined conditional quote <=CNY0.027876; full CNY1 reservation leaves
  CNY0.972124 unallocated margin. This is an intentionally large operational
  margin, NOT proof of undisclosed minimum-duration, rounding, disconnect or
  provider billing behavior. Actual charge remains unsettled until the provider
  console/bill is checked. Do not report the reserved yuan as an observed charge.

Sources: [Alibaba pricing](https://help.aliyun.com/zh/model-studio/model-pricing),
[DeepSeek pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/),
[official manual ASR protocol](https://help.aliyun.com/en/model-studio/qwen-asr-realtime-client-events).
The old DeepSeek plaintext/token bound conditions still apply; no tools, images,
history, thinking, alternate endpoint or arbitrary model can enter this runner.

## Preparation (operator, not this implementation task)

Use the existing approved private ASR and translation JSON files (`{"apiKey":"…"}`),
owned by the service/operator identity, with no group/world permission (0600).
Pass only file paths, never key values. The PCM file must be a deliberately chosen
synthetic fixture, regular non-symlink raw signed PCM16 little-endian, mono16kHz,
2..320000 bytes and even length. WAV/RIFF containers are rejected, not decoded.
There is no automatic conversion/download/capture. Explicit confirmation attests
that the file is synthetic and already authorized for the stated providers.

The existing new audio batch must already be initialized privately and unspent:

```json
{"version":1,"batch":"lingobar-audio-test-2026-10-30","reservedMicroCny":0,"attempts":0}
```

This is a shape example, NOT an instruction to overwrite an existing ledger.
The directory must be0700, ledger0600. Stop any gateway holding the same audio lock
through the existing authorized operational process; never delete a live lock.
Do not change the old text ledger, site permissions or provider controls.

## Commands

Bundled `dist/gateway/audio-test.cjs` requires existing Node22; no runtime npm install.
Default execution is a plan only, with no file/key read, ledger reservation or network:

```sh
node audio-test.cjs
node audio-test.cjs --dry-run
```

After the deployment owner validates the selected synthetic fixture, private files,
new unused batch, and the approved one-shot billing margin:

```sh
node audio-test.cjs --execute --confirm-synthetic-audio \
  --ledger-directory /ABSOLUTE/EXISTING/NEW-AUDIO-BATCH \
  --asr-key-file /ABSOLUTE/PRIVATE/dashscope.json \
  --translation-key-file /ABSOLUTE/PRIVATE/deepseek.json \
  --pcm-file /ABSOLUTE/APPROVED/SYNTHETIC.pcm
```

The paths are local/non-secret parameters, not fixed deployment values. The runner
accepts no API key argument, env key fallback, model/URL override, microphone option,
retry or reconnect flag. Exit0 = dry-run or completed; exit2 = blocked before
execution/invalid arguments; exit3 = incomplete after reservation. Inspect JSON
`status`, not merely exit0. A failed durable write reports `reservationState:uncertain`
and `reservedMicroCny:null`; inspect the existing ledger rather than assuming no debit.
Never automatically repeat exit2/3 or a timed-out run.

## Exact request behavior and result

Only one ASR connection can be attempted, at the fixed DashScope Beijing realtime
URL. The30-second deadline includes handshake and sending. Manual mode sends
3200-byte PCM chunks at100ms intervals, then one `input_audio_buffer.commit`.
Partials are ignored. Only the first nonempty final after commit can be translated;
ASR is disconnected first. Missing final, timeout, cancellation, invalid response or
failed ASR means ZERO translation requests. No ASR reconnect/automatic retry exists.

Only one nonstream DeepSeek `deepseek-flash` request follows, target Simplified
Chinese, max_tokens1024, thinking disabled, tool_choice none, JSON response. The full
request must pass the existing8192-token bound before dispatch. No ruby/format retry
or partial translation. Translation deadline30seconds. Every failure/unknown outcome
retains the entire new reservation. A process crash still leaves the durable debit
(and possibly a lock requiring operator investigation), never a refund.

Stdout is one redacted JSON record. It may include the synthetic transcript and
Chinese translation and only recognized nonnegative integer DeepSeek usage fields.
It never emits the provider's raw body/error or either input key. `asrUsage:null`
means the realtime protocol does not guarantee a returned usage record;
`actualChargeCny:null` and `billingStatus` require provider-console reconciliation.
A successful mocked result is not live ASR acceptance, real translation quality,
a supplier key check, a settled bill, or proof the webpage's listen button works.
