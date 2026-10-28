# Private Web gateway — deployment preparation

This is an **undeployed, disabled-by-default** Node.js 22 gateway, stacked on
PR13 `2b0af19186c4953f55dc6f4f4aa6b4a43671f249`. It reuses the existing Worker
ASR/translation/annotation/session code and the unchanged browser contract.
It does not include an active provider account, keys, free balance, or hardware
acceptance. PR4's independent desktop pause drain is not included.

**Current live-test authorization is one RMB total across all providers, not per
day.** The ordinary gateway limits below are not a monetary cap. Keep it disabled
for that test; use the [one-RMB preparation and unresolved proof requirements](one-rmb-test.md).
The offline plan/accounting module includes no live executor and does not retrofit
a monetary guard onto this gateway.

## Runtime and data flow

Run the gateway on the existing Linux VM, listening on `127.0.0.1:8788` only.
This is a network relay, **not local model inference**: a two-core/1GiB VM without
a GPU is not being asked to run ASR or an LLM. Its suitability for actual user
traffic still needs measurement. No new Cloudflare Worker, Durable Object,
database, hosting subscription, or Cloudflare API token is needed for this path.
The [separate Worker build](https://github.com/seihn2/lingobar/blob/2b0af19186c4953f55dc6f4f4aa6b4a43671f249/docs/workers-relay.md) still requires its own verifier and
account-wide budget integration; this gateway does not claim to deploy it.

1. After an explicit Start action, the browser opens a same-origin WebSocket.
   The gateway verifies the Access application JWT, exact public Host/Origin and
   remaining local allowance before starting an upstream. Only after ASR readiness
   does the existing browser acquire a microphone and send mono16kHz PCM16.
2. PCM passes through Cloudflare Access/Tunnel and VM memory to Alibaba's
   `dashscope.aliyuncs.com` WebSocket API (Beijing legacy endpoint). Model is selected on
   the server: default `qwen-audio-3.1-asr-flash-streaming`; the existing3.0
   streaming or `qwen3-asr-flash-realtime` alternatives remain available.
   Alibaba now [recommends workspace-specific domains](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-websocket-api).
   This batch retains the existing fixed legacy endpoint; if the owner's account
   requires a workspace domain or another region, a bounded server-side adapter
   adjustment is needed before enabling it. No arbitrary browser URL is accepted.
3. Partial/final recognized text goes to DeepSeek's fixed
   `https://api.deepseek.com/chat/completions`, model `deepseek-flash`, for the
   selected languages. Optional Japanese ruby sends source/Japanese text to the
   same provider. Annotation-only retry uses `/api/annotation`, without audio or
   an ASR socket. No media is sent to DeepSeek by this implementation.
4. Versioned text/ruby returns to the browser. The gateway stores no audio,
   captions, provider responses, JWTs or identities. Browser favorites retain
   their existing local persistence. The only gateway state is daily numeric
   usage reservations. Provider-side handling is governed by the provider's terms.

Phone Web is microphone-only. It cannot promise other-app/system audio capture,
background/lock-screen recording, Electron's floating window or tray/global
shortcuts. Pagehide, errors and stop release the existing browser recording.

## What the owner must confirm once, before real use

| Item | Actual requirement |
| --- | --- |
| ASR secret | A dedicated Model Studio API key entitled to the selected model at the Beijing endpoint: `ASR_API_KEY`. Region/account/model entitlement and remaining grants are **unknown**; no desktop key was read or migrated. |
| Text secret | A dedicated DeepSeek API key: `TRANSLATION_API_KEY`. Balance/grants are **unknown**. It covers both translation and optional Japanese annotation. |
| Access metadata | Existing application's `ACCESS_ISSUER` (`https://<team>.cloudflareaccess.com`), 64hex `ACCESS_AUDIENCE`, and one `ACCESS_ALLOWED_EMAIL`. These are server routing/policy metadata, not an API token or Google password. |
| Data/budget authorization | Consent to the above audio/text destinations; explicit positive `GATEWAY_DAILY_SESSIONS` and `GATEWAY_DAILY_COMPLETION_REQUESTS`; provider-side spend caps/free-quota-only controls if available. |
| Operator action | Install the verified gateway bundle using an already available Node22 Linux runtime; supply a private environment outside the Web root and a private writable state directory; route the fixed paths below through the existing private origin. This task does not change VM/proxy/Tunnel/Access settings. |

Do not enter keys into chat, Git, a browser config, an uploaded artifact, a URL,
or a shell command that prints them. The executable reads only its deliberately
provided process environment, not Electron settings, .env files or user keychains.
Use a dedicated unprivileged service account with access only to its configuration
and state. Outgoing destinations are the two fixed providers and the pinned
Access team's public certificate endpoint. No provider administration credentials
or new Cloudflare authorization are required by the code.

The free website/VM route does **not** make provider inference free. As checked
on2026-10-28, [Alibaba's official pricing](https://help.aliyun.com/zh/model-studio/model-pricing)
lists3.1 streaming at6CNY/million input tokens and4.5CNY/million output tokens
in Beijing, with a1million-token initial grant subject to90-day conditions;
3.0 streaming instead lists0.00033CNY/second and36,000 initial seconds.
These are different models/units; do not call the3.1 default a free10-hour plan.
[DeepSeek's official pricing](https://api-docs.deepseek.com/quick_start/pricing/)
lists the flash model's uncached input atUS$0.15/off-peak or0.30/peak per million
tokens and output atUS$0.60/1.20. These are published rates, not verified user
entitlements or a spending estimate. Existing account grants/expiry, currency,
availability and provider billing must be checked by the owner. No paid request
or account balance lookup was made.

## API and authorization

Keep the existing static files and Access policy. The proxy must preserve the
public Host and `Cf-Access-Jwt-Assertion` supplied by Access, support WebSocket
Upgrade, and route **only** these exact paths to the loopback gateway:

| Path | Method and behavior |
| --- | --- |
| `/app-config.json` | GET: `backend:null` while disabled; after valid configuration and JWT, only `backend:"/api/session"`. Never returns credentials/models. Override the old static config with this dynamic route. |
| `/api/session` | GET + WebSocket Upgrade, exact Origin required. Version1 start/stop/retry controls and binary PCM, same browser implementation. No arbitrary proxy destinations. |
| `/api/annotation` | POST JSON, exact Origin and JWT required; bounded text-only versioned annotation. No microphone acquisition. |
| `/healthz` | Local GET only, do not proxy publicly. Returns `disabled`503 or `configured`200. This checks local configuration/construction only, **not** provider reachability, balance or recognition quality. |

Disabled startup is simply `node gateway/gateway.cjs` with the checked-in
`WEB_ENABLED=0` default. Enabled startup requires all keys/metadata and positive
caps in `gateway.env.example`; the template is not loaded automatically. Never
serve that template/configuration/state directory as static assets. Missing or
invalid enabled configuration causes startup failure with a fixed redacted error.

Access signatures use Node's RSA-SHA256 verification and pinned issuer/audience,
expiry/issued-at/not-before checks and an exact email allowlist. Only the fixed
team JWKS endpoint is fetched (3s deadline,64KiB maximum,5minute cache,30s reload
throttle/coalescing). No `jku`, browser assertion flag, Cookie, X-Forwarded-Host
or arbitrary key URL can authorize a request. A verified token cannot outlive its
expiry on the audio socket or an annotation request. Local validation is **not
an online revocation lookup**: existing signed tokens remain usable until expiry;
an emergency gateway stop cuts active sessions, and Access session policy/revocation
must be managed by the owner. No JWT, key, upstream body, email, audio or caption
is printed in the application's logs. Proxy/runtime logging remains an operator
responsibility.

## Hard stops and recovery

The gateway permits one audio connection, two annotation operations, four pending
identity checks and60API requests/minute per process. Native WS payloads are
bounded to128KiB, send buffers to256KiB; compression and redirects are disabled.
The shared relay retains its5minute/9.6MB PCM cap,64KB frames,35s audio idle,
20s ASR startup,25s completion deadline,40actual completion attempts/session,
bounded scheduler, revisions and final gates. Provider401/403/429 are fixed
auth/quota errors; other failures are fixed upstream errors. No automatic
reconnect, provider retry loop or microphone restart is added. Manually starting
again requires a new authorized connection and another reservation. Web stop is
hard cancellation; it does not promise desktop PR4's graceful final drain.

Before opening ASR, the gateway persistently reserves **one full session and40
completion attempts**. A standalone ruby request reserves two attempts, covering
its existing format retry. Unused reservations are not refunded, including errors
and early pause. All browsers share these caps. Counters survive normal restarts
in a0600 `budget.json` inside a0700 directory; no audio/text/identity enters it.
Writes use an exclusive temporary file, fsync and atomic rename. Full disk,
corrupt state, unsafe permissions, failed writes or clock rollback refuse further
use. The UTC date resets counters only on the next day, never on browser reload.
These are conservative **request/session hard bounds, not a currency limit or
proof that a provider's free grant is still available**. A single model call can
charge tokens; provider-side account caps are still necessary for a zero-spend
requirement.

Only one gateway process may own this state: an exclusive lock prevents a second
writer. Do not run cluster replicas or delete/reset the ledger to recover.
After a crash an operator must first confirm that no gateway owns the directory,
retain the last valid counters, inspect any pending write and then recover the
lock conservatively. Automatic lock takeover or budget refund is deliberately
absent. SIGINT/SIGTERM closes HTTP/WS, cancels sessions/annotations and releases
the lock. This code does not create a login item or enable OS startup.

## Offline verification and handoff

```sh
npm run typecheck
npm run test:gateway
npm run test:worker
npm run test:web
npm run build:web && npm run verify:web
npm run build:gateway && npm run verify:gateway
```

The existing Worker CI also builds and uploads a disabled `vm-gateway-disabled-<head>`
artifact with the bundled gateway, static reference files and a head/tree/file
checksum manifest. No runtime npm install is needed: existing ws8.22.0 (MIT)
is bundled, its notice is retained, optional native add-ons are not included.
Implementation is original CC BY-NC4.0 code; Node HTTP/crypto/fs and Cloudflare
Access [official validation guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
are used without copying an SDK or adding dependencies. This VM choice avoids
assuming that the [Workers Free CPU limits](https://developers.cloudflare.com/workers/platform/limits/)
are already measured or that a cross-isolate budget/verifier exists.

Tests use generated RSA signatures, synthetic text/PCM, temporary state and real
**loopback** HTTP/WebSockets with mocked fixed upstreams. They do not contact
Cloudflare JWKS or a provider account. Browser UI regressions remain synthetic;
the dynamic public route and WS handshakes need a deployment smoke test after
authorization. Real Access assertions, VM/Tunnel integration, provider entitlement,
latency/quality/billing, iPhone/Android mic/interruptions and physical assistive
technologies remain unverified. A build/CI pass is not live-function acceptance.
