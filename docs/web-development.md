# Standalone Web: first development batch

This branch adds an independent browser entry and a microphone-session adapter.
It starts from draft PR3 `6ed9b30683a4b1aa8b86fd842a5fc7aafd6ad763` and is
reviewed separately. PR4's pause drain and PR5's furigana timing changes are not
silently included. The existing Electron entries, native helpers and desktop workflow
are unchanged. Shared caption/history components add only an optional
`allowRemoveSaved` flag, false by default and enabled by the Web entry; desktop
bookmark behavior retains its existing default.

## Run and build

Use the existing locked dependencies; no additional package is required:

```sh
npm run dev:web
npm run typecheck
npm run test:web
npm run build:web
npm run verify:web
npm run test:web-ui
```

`dist/web/` is a standalone static build, with the existing LingoBar artwork,
project license and bundled third-party notices. The browser entry does not use
Electron, Node, the desktop preload, native helpers or provider API keys. The
home-screen manifest is included. No service worker or offline recognition is
provided.

The shipped public `app-config.json` is `{"version":1,"backend":null}`.
The real page shows **后端未配置**, disables start, and requests neither audio
nor a service socket. There is no built-in simulated transcript/provider. All
synthetic implementations are confined to test entries excluded from the build.
The only accepted future route is the same-origin `/api/session`; a public
configuration file cannot redirect audio to an arbitrary provider or carry keys.
The first batch does not implement or deploy that server route. The subsequent
[fixed-upstream relay batch](workers-relay.md) implements its server contract,
default denied and not deployed; it still requires a verified auth service and
explicitly authorized server configuration before real use.

## Browser behavior

- Explicit start opens the configured route and waits for matching readiness
  before requesting the microphone. The existing AudioWorklet emits mono16kHz
  PCM16; there is no real-audio test in this batch.
- Stop, cancellation, page hiding, permission failure and connection failure
  release capture and invalidate the owner. A late permission grant is released.
  There is no automatic reconnect or capture restart. This Web batch uses hard
  stop; desktop PR4's bounded final drain is separate.
- The shared caption stream, compact reader, language settings and local history
  preserve source/selected-language order, translated partials, matching ruby,
  review anchors and Back to live. On hard stop, a valid translated prefix stays paired with its source while
  recognized untranslated words remain visible as an incomplete result; pending
  ruby terminates as incomplete. A new run namespaces upstream caption IDs;
  revisions and stale-run guards prevent older callbacks replacing current text.
- Preferences, history and favorites live in this page's memory. Refresh clears
  them. History keeps at most500 rows, preserves saved rows, and refuses another
  row when all500 are saved. Per-run revision tombstones are bounded at2000; an
  evicted row cannot reappear from a late revision. Export requests a Markdown
  download; the browser cannot confirm a successful filesystem write.
- Retry uses only the current connected session's captions. Older-session rows
  remain readable, copyable and savable. Changing target languages or furigana
  stops capture before applying the new settings. No desktop pin/tray/global
  shortcut/login-item UI is presented, and startup enable requests are rejected.

## Version1 transport contract

`src/shared/web-protocol.ts` is browser-safe and independent of transports.
Every JSON control message has `version:1` and an opaque `sessionId`.

| Direction | Message |
| --- | --- |
| Browser → server | `start` with selected `targetLanguages`, `showOriginal`, `showFurigana`; `stop`; `retry` with the upstream caption ID |
| Browser → server | Raw bounded PCM16 `ArrayBuffer` frames after readiness |
| Server → browser | `ready`; `caption` with a positive safe-integer per-caption `revision` and bounded caption data; `retract` for a removed speculative live chunk; `error` with `unauthorized`, `quota`, `upstream`, `protocol` or `unavailable` |

Text frames are limited to128KiB UTF8 and caption text to8000 UTF16 units.
Only known translation languages and at most8 targets are accepted. Ruby must
exactly reconstruct the Japanese translation and place kana only on matching
kanji. Unknown fields are not copied; server-provided saved flags and free-form
provider errors are not trusted. Audio is capped at64000 bytes per frame with
a512000-byte socket-buffer budget. Malformed/overloaded sessions stop visibly.

The [relay](workers-relay.md) requires an internal authorization verifier, attaches
provider authorization only server-side and bounds its own sessions/queues.
Workers' WebSocket support does not by itself validate this application's
provider handshake, quota or CPU usage. No Cloudflare resource, token, secret,
live provider call or deploy workflow is created here.

## Verification boundaries

The new Web workflow builds and inspects the unconfigured production page,
runs protocol/session tests, then uses the installed Chromium browser with fake
capture and fake sockets. It checks phone-width layouts and shared reading
behavior. Media APIs and native browser service sockets throw in the fixture,
so tests cannot silently use a real microphone/provider. Screenshots contain
synthetic captions only. Linux CI may lack CJK fonts; DOM/ruby checks are not
native iPhone typography acceptance.

The CI artifacts are a **backend-unconfigured static build** and synthetic
evidence, not an online service. iPhone/Safari microphone permission, AudioWorklet,
home-screen behavior, interruptions, real Workers runtime, live upstream latency
and actual API usage have not been verified. Desktop CI remains a separate
regression layer. No simulator, browser viewport or successful build is called
physical acceptance.

All new implementation is original project-local CC BY-NC4.0 work. No new
third-party source, dependency, paid service or billing plan is introduced.
