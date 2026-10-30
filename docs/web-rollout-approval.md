# One staged production approval checklist — not executed by the code task

This checklist accompanies the fixed final source/CI/build manifest. It does not
itself approve or execute a rollout. A previous PR21 activation attempt was denied
before execution. Current observed production remains PR19
`1e79b852435869e3497486a3564833c4a4ea44ac`.

## Confirmed existing locations (from deployment worker's prior observations)

- Existing release: `/opt/lingobar-gateway/releases/1e79b852435869e3497486a3564833c4a4ea44ac`,
  with `web/`, `gateway/gateway.cjs`, and `GATEWAY-MANIFEST.json`.
- Node22: `/opt/lingobar-gateway/runtime/node-v22.23.4-linux-x64/bin/node`.
- Static/API wrapper: `/opt/lingobar-preview/serve_static.py`;
  HTTPS entry: `/opt/lingobar-preview/serve_https.py`.
- Units: `/etc/systemd/system/lingobar-gateway.service` and
  `/etc/systemd/system/lingobar-web.service`.
- Gateway identity `lingobar-test`; `ProtectSystem=strict`; current write paths
  are ONLY `/var/lib/lingobar-text-test/credentials` and
  `/var/lib/lingobar-text-test/lingobar-test-2026-10-28`.
- Web identity `lingobar-web`; `ProtectSystem=strict`; no write paths;
  working directory `/opt/lingobar-preview`.
- Existing key: `/var/lib/lingobar-text-test/credentials/deepseek.json` (no content
  read by this task). Existing cumulative text ledger directory is exactly
  `/var/lib/lingobar-text-test/lingobar-test-2026-10-28`.
- Existing private HTTPS origin `[fd8d:78fe:9cf1:1::4]:9443`; gateway loopback8788.
  No network listener/firewall/DNS/Tunnel/TLS changes are needed or authorized here.
- Existing environment-file path was NOT reliably established. Retain the actual
  existing configuration mechanism; do not invent or replace an unknown env file.

## Proposed bounded changes to approve together

1. Install the fixed final paired `web/` + `gateway/` under
   `/opt/lingobar-gateway/releases/<FINAL_REMOTE_SHA>/`, with the exact manifests,
   and update only the two named existing services/wrapper to that release.
   Back up current unit/wrapper/config references for rollback. Restart only those
   two LingoBar units after static/gateway verification; no other service changes.
2. Add private0700 directories, owned by existing `lingobar-test`:
   `/var/lib/lingobar-text-test/accounts`,
   `/var/lib/lingobar-text-test/shared-account-budget`,
   `/var/lib/lingobar-text-test/lingobar-audio-test-2026-10-30`.
   Keep files0600. Add ONLY these three directories to gateway ReadWritePaths;
   retain both original write paths; keep web read-only and both current users.
3. Preserve `WEB_TEXT_ENABLED=1`, original Access metadata, DeepSeek file and text
   ledger path/cumulative bytes. Keep `WEB_ENABLED=0`: owner streaming test guard
   remains closed, while public BYOK has its separate60-second limit/policy.
   Set `ASR_API_KEY_FILE=/var/lib/lingobar-text-test/credentials/dashscope.json`;
   saving this key is an explicit owner action via protected `/owner` form, never
   chat, code, logs or an automatic provider validation call.
4. Set `APP_AUTH_ENABLED=1`,
   `APP_ACCOUNTS_DIRECTORY=/var/lib/lingobar-text-test/accounts`,
   `APP_SHARED_BUDGET_DIRECTORY=/var/lib/lingobar-text-test/shared-account-budget`,
   `APP_SHARED_LIMIT_MICRO_CNY=0`, `APP_SHARED_ASR_FREE_STOP_VERIFIED=0`.
   Account and site shared quotas start0. No unlimited/common-key spending grant
   is implied. Initialize new shared budget only at0, and initialize the approved
   new audio batch only if truly absent/unspent. Never replace an existing ledger.
5. Update wrapper route allowlist/body limits and websocket relay (not currently
   implemented by the old wrapper): config GET, text POST8192, annotation POST65536,
   credentials/auth mutations8192; fixed paths listed in web-accounts-deployment.md.
   Preserve Host/Origin/Sec-Fetch-Site/Access assertion/Content-Type, add same-origin
   Cookie/Set-Cookie forwarding, forbid API cache/body logging. Relay `/api/session`
   and `/owner/api/session` WebSocket upgrades/binary frames to loopback8788 with
   disconnect propagation. Do not turn the wrapper into an arbitrary forward proxy.
6. First test behind current Access. Owner opens protected `/owner`, creates the
   initial admin with a chosen password through the HTTPS form, optionally saves
   ASR key. Do not precreate a real password or use a default. Initialization is
   independently gated by the original owner JWT, even if routing is wrong.
7. After successful private checks, open ONLY public static `/`, public app config,
   application auth/session/translation/annotation paths to visitors. Retain strict
   owner Access on `/owner`, `/owner/*`, unprefixed `/api/settings/*`, and unprefixed
   `/api/auth/bootstrap`. Preserve identity issuer/audience/owner restriction. Check
   anonymous/cookie-only users cannot bootstrap or persist provider keys; normal
   app users cannot administer accounts. Do not broadly remove the owner policy.
8. Separately run the already-approved once-only audio test only after ASR key and
   an approved finite synthetic PCM fixture are ready. `audio-test.cjs` default is
   dry-run; explicit execute+synthetic confirmation required. It reserves the FULL
   new1CNY batch before at most1ASR+1translation; no refunds/retries. Exact command,
   exit codes and conditional ¥0.027876 published-rate bound are in
   one-shot-audio-test.md. Never use the old text ledger or public account ledger.
   Capture safe numeric usage/output; actual ASR invoice remains pending console
   reconciliation, not claimed proven by a mocked success.

## Acceptance and rollback

Before opening: verify owner key save/readiness without key echo, unchanged original
text ledger, explicit admin bootstrap, guest/account isolation, guest saturation
cannot block admin login, shared quota0拒绝, logout/expiry, and cookie/websocket
forwarding. Confirm static manifests and selected remote SHA. Public BYOK requires
explicit own-billing consent and has no claim to the owner's1CNY allowance.

Rollback: restore previous paired release/unit/wrapper/config references and the
specifically changed Access public-route rules. Set APP_AUTH_ENABLED=0 and keep
WEB_ENABLED=0. Restart only the same two services. RETAIN every old/new ledger,
credential and accounts file; do not reset money or remove live locks. No TLS,
firewall, DNS, unrelated service, cloud resource, or new system-account changes.
