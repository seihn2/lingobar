# Fixed-upstream Web relay — development preview

This second Web batch builds on the frozen [browser entry in PR6](https://github.com/seihn2/lingobar/pull/6),
source `1e1304ce8809bcf1fd5ea788668354013764e7cf`. It adds server-side adapters and
their browser contract. It is **not deployed**. No working online URL, login
service, account binding, provider key or iPhone acceptance is included.
PR4's desktop pause drain and PR5's annotation timing changes remain separate.

## Implemented protocols

| Purpose | Fixed server destination | Protocol |
| --- | --- | --- |
| Default ASR | `https://dashscope.aliyuncs.com/api-ws/v1/inference` with WebSocket Upgrade | `qwen-audio-3.1-asr-flash-streaming`, or server-selected `qwen-audio-3.0-asr-flash-streaming`; `run-task`, matching `task-started`, binary mono16kHz PCM16, result-generated partial/final/stash |
| Alternate ASR | `https://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime` with WebSocket Upgrade | `session.update`/`session.updated`, base64 PCM append, transcription text/completion events |
| Translation and optional ruby | `https://api.deepseek.com/chat/completions` | `deepseek-flash`, non-streaming JSON Chat Completions; existing selected-language prompts and validated kanji/kana slots |

Audio sessions accept selected languages and display preferences. The separate
[annotation-only route](annotation-retry.md) accepts bounded finalized source/Japanese
text and versioned identity, including while paused. The browser cannot
supply a destination, model, provider key, custom headers or general proxy request.
Provider authorization stays in server request headers. Redirects are rejected.
The adapters target these documented protocols; model entitlement, regional key
compatibility and current live behavior have **not** been tested with an account.

Sources checked on2026-10-26: Alibaba's [streaming client events](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-asr-streaming-client-events),
[streaming server events](https://www.alibabacloud.com/help/en/model-studio/qwen-audio-asr-streaming-server-events),
[realtime client events](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-realtime-client-events)
and DeepSeek's [Chat Completions reference](https://api-docs.deepseek.com/api/create-chat-completion/).
These are protocol references, not copied SDK code.

## Configuration and authorization boundary

The checked-in example `worker.example.jsonc` is disabled: `WEB_ENABLED="0"`,
`workers_dev=false`, `preview_urls=false`, no routes, account IDs or secrets.
There is no deployment workflow or deployment command in this project.

An enabled server requires all of the following future server bindings:

- `WEB_ENABLED="1"` and one of the three allowed `ASR_MODEL` values.
- `ASR_API_KEY` and `TRANSLATION_API_KEY`, supplied only as server secrets.
- `AUTH_SERVICE`, an internal service binding implementing the verifier contract below.
- Optional `ASSETS`, the same-origin static build binding.

If a required value is absent or invalid, `/app-config.json` returns only
`{"version":1,"backend":null}` and `/api/session` refuses with503. The browser
shows **后端未配置**, disables start and requests no microphone. A denied verifier
returns401; the page shows **服务未授权**. Neither route returns provider settings. `/api/annotation` also defaults to503;
it needs only the translation secret and verifier, never an ASR key or socket.

`AUTH_SERVICE` is an explicit **integration placeholder**, not an implemented
login system. Before enabling any provider use, its owner must implement and
verify identity, session expiry/revocation, access policy and account-wide
connection/usage limits. The relay itself does not provide cross-connection or
cross-isolate billing enforcement. A client-supplied header is never proof:

1. For same-origin HTTPS config/session/annotation requests, the relay calls the service
   binding at the fixed internal URL `https://auth.internal/authorize` with POST.
2. It forwards bounded Cookie and Cf-Access-Jwt-Assertion values as **untrusted
   evidence**, plus JSON `{origin, path:"/api/session"}` (or fixed `"/api/annotation"` for text-only annotation). It does not forward a
   browser Authorization header or an asserted authorization flag.
3. Only a204 response authorizes. Any other response, exception, abort or3s
   timeout denies access. The response body is discarded. No auth response
   or cookie is returned to the browser. The binding must independently validate
   signatures and audience; returning204 unconditionally would be unsafe.

The relay rejects cross-origin WebSockets, non-GET audio-session controls, query-string
proxy options, unknown API paths and malformed controls before starting ASR.
Connecting the verifier, choosing an account/hostname, configuring secrets and
deploying remain separate steps requiring the user's authorization. None has
been attempted here.

## Lifecycle and resource bounds

One connection owns its ASR socket, queue, request budget and abort controllers.
Matching upstream readiness precedes browser microphone acquisition. Stop,
disconnect, provider failure and idle expiry cancel owned work; there is no
automatic reconnect or audio restart. Web stop is an immediate hard cancellation,
so the last unfinalized utterance can remain incomplete; it does not claim PR4's
desktop graceful drain. No audio, captions or keys are persisted by this relay.

The shared caption scheduler retains its existing650ms first-partial delay,
latest-draft coalescing, bounded waiting queue, final/draft fairness, two translation
slots and two annotation slots. The desktop wrapper retains its UUID/diagnostic
hooks. ASR protocol helpers are shared; the desktop ASR session class is unchanged.

| Per-connection bound | Limit |
| --- | --- |
| Start control / ASR startup / audio idle | 5s /20s /35s |
| Completion or annotation operation | 25s, including cancellation of an unresponsive transport |
| Session lifetime / accepted PCM | 5minutes /9,600,000 bytes |
| PCM frame / rate allowance | 64,000 bytes, positive even length;64,000-byte burst plus32,000 bytes/s |
| Created caption chunks / transcript events | 200 /2,000 |
| Actual completion HTTP requests, including annotation retries | 40 total |
| JSON frame / text / total outgoing JSON | 128KiB UTF8 /8,000 UTF16 units /6MB |

HTTP401/403 and429 become fixed unauthorized/quota errors, with no upstream body
or credentials in browser feedback. Exhausted limits stop the session visibly.
Caption errors can be retried within the same session; duplicate pending retries
are coalesced. Sequence revisions, run ownership and final gates prevent late
responses replacing a newer final or another session. A `retract` message removes
only an unsaved live speculative chunk; browser tombstones prevent its resurrection.
Final history and browser-local favorites survive. Old draft translations can
remain visible paired with their exact `translatedOriginal` while corrected live
source is being translated; final correction supersedes them.

Cloudflare's [WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
supports accepted WebSocketPairs and outgoing fetch upgrades. This implementation
uses those Web APIs and explicitly selects ArrayBuffer binary messages. It has
no Node compatibility flag, Node ws, Electron runtime or third-party runtime SDK.
Cloudflare's [limits reference](https://developers.cloudflare.com/workers/platform/limits/)
currently documents a free tier with10ms CPU,128MB memory,50 subrequests per
invocation and six simultaneous outgoing connections awaiting headers. The40-request
completion budget leaves subrequest headroom for auth and ASR; the scheduler bounds
outgoing concurrency. These are conservative design bounds, **not measured proof**
of free-tier suitability. Serialization, parsing, audio/base64 processing and
timer/connection behavior still require measurement in the actual runtime.
Provider APIs can charge separately. There is no unlimited-use or zero-cost claim.

## Offline verification and artifacts

Use existing locked dependencies; no additional install is needed:

```sh
npm run typecheck
npm run test:worker
npm run test:web
npm run build:web
npm run verify:web
npm run build:worker
npm run verify:worker
node scripts/archive-worker.cjs
```

The new workflow uploads `workers-relay-disabled-<head>` containing `worker/`,
`web/`, `RELAY-MANIFEST.json` and `RELAY-SHA256SUMS.txt`. The manifest records the
source head/tree, PR base, checkout and file checksums. It is a disabled test
artifact, not a deployed service or signed installation package. GitHub artifacts
expire after14days and require GitHub access; the current PR/Actions result is
the source for the exact download link. No permanent public download is promised.

Tests use synthetic PCM buffers, controlled sockets, HTTP responses, verifier
bindings and fake clocks. The integration chain runs the actual BrowserSession,
RelaySession, Worker ASR, shared queue and completion/annotation code; global
network calls are forbidden. Tests cover auth denial, missing configuration,
fixed destinations, partial/final/stash ordering, retraction, late replies,
cancel/close/timeout cleanup, retry, quota, selected languages and ruby.

Node cannot construct a real101 Workers response: tests inject that boundary.
The browser-target ESM bundle is inspected, but **workerd/Miniflare and a deployed
Cloudflare runtime have not run**. No new runtime tool was installed. Real provider
handshakes/accuracy/latency, account-wide limits and actual CPU usage remain
unverified. iPhone/Safari microphone/AudioWorklet activation, interruptions and
home-screen behavior also remain unverified. Desktop CI is a regression layer,
not Windows audio hardware or iPhone acceptance.

Implementation is original project code under CC BY-NC4.0. Cloudflare's API
documentation is referenced, not copied; its documentation repository uses
[CC BY4.0](https://github.com/cloudflare/cloudflare-docs/blob/production/LICENSE).
The existing locked esbuild0.25.9 (MIT) is used only for building; none of its
runtime code or a new SDK is added to the Worker. The artifact retains the
project license and existing notices. No unrelated private source is included.
