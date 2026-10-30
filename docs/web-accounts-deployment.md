# Application accounts and guest BYOK — default disabled

This is a separate rollout after the ASR setup patch. It does NOT open the live
site, initialize a real account/password, change Access, or authorize public use
of either previous owner test budget. It must not be put in the ASR-only package.

## Architecture and authorization

- Existing Access signature/issuer/audience/expiry/owner checks remain the ONLY
  administrator bootstrap authorization. Anonymous users cannot elect the first
  administrator, even when the accounts file is absent. No default login/password.
- The authenticated owner opens the account panel and explicitly creates an admin
  (e.g. a chosen `lingobaradmin` username) with a private password of >=12 characters.
  Do not place the password in chat, source, CLI arguments, environment or logs.
- Passwords are salted scrypt hashes in private 0600 `accounts.json`; provider keys
  are not copied into account records. Accounts have admin/user roles. Admins can
  create/revoke normal users and assign cumulative quotas, but cannot read keys.
  Initial admin bootstrap and persistent provider-key settings remain Access-owner
  only. Normal users cannot manage accounts or provider credentials.
- Random server-side sessions use a Secure, HttpOnly, SameSite=Strict, host-only
  cookie; tokens are stored hashed server-side. Account sessions last at most 8h,
  guest sessions at most 1h. Logout, account removal/password/limit changes revoke
  relevant sessions; restart invalidates all sessions. Streaming/retrying work
  rechecks the session, and active work is stopped on expiry/revocation.
- Guest BYOK requires explicit own-billing consent, sends keys by same-origin
  HTTPS POST, and retains them only in the server's volatile session memory, never
  in browser storage, snapshots, logs, responses or account files. Guest A cannot
  use or inspect guest B's keys. Fixed DashScope Beijing and DeepSeek destinations
  prevent an arbitrary credential-bearing proxy.

## Configuration (all new behavior off by default)

```dotenv
APP_AUTH_ENABLED=0
APP_ACCOUNTS_DIRECTORY=/var/lib/lingobar-accounts/auth
APP_SHARED_BUDGET_DIRECTORY=/var/lib/lingobar-accounts/budget
APP_SHARED_LIMIT_MICRO_CNY=0
```

Enable `APP_AUTH_ENABLED=1` only in the approved matched app+gateway deployment,
retaining `WEB_TEXT_ENABLED=1`, the original owner Access metadata/key locations
and ORIGINAL text test ledger. The new auth and budget directories must already
be private0700 and owned by the existing service identity; files are0600. Any
new service write allowlist requires deployment approval; this code does not set
permissions or create system users. The account-budget constructor can initialize
its ledger only with site limit0. A missing ledger with a positive site limit
fails closed rather than accidentally granting fresh money. Keep all ledgers
on restart or rollback. Never point shared-public funding at an owner test ledger.

## Shared-account vs guest funding

The owner's prior text ledger and new <=CNY1 audio test ledger are NOT used by
public accounts or BYOK. Shared-account completions reserve their exact existing
DeepSeek request upper bound from BOTH the new persistent site ledger and the
stable account UUID's cumulative quota before every dispatch, including ruby
format retries. Cancel/failure/unknown results never refund. Deleting/recreating
an account never clears site spend. Default per-account AND site limits are0.
Positive limits are a separate spending authorization, not implied by this patch.
Admin changes individual cumulative quotas; the deployment operator controls the
cumulative site reservation ceiling. Neither setting resets already reserved money.

Shared-key ASR supports normal paid service, not only free credits. The fixed Beijing
`qwen3-asr-flash-realtime` model uses the published CNY0.00033 per input-audio second
rate (checked 2026-10-30). Before the sole connection attempt, reserve the entire
60-second allowance: **19800 micro-CNY (CNY0.0198)** from BOTH site and account.
Opening is refused unless that amount plus the maximum first translation allowance
81920 micro-CNY remains. Each actual translation/annotation attempt (including ruby
format retries) then separately reserves its complete input/output bound before
sending; no more than40 attempts per audio session. Input<=8192 tokens and
output<=8192 tokens, uncached input CNY2/M and output CNY8/M: each<=CNY0.08192.
Thus a full session's published-rate envelope is CNY3.2966, but smaller configured
budgets stop subsequent requests before they exceed the remaining reservation cap.
No ASR reconnect/retry within a session; a later user-started session must reserve
anew. One principal cannot run two audio sessions. Durable writes and exclusive
ledger locks prevent concurrency/restart from granting the same allowance twice.
Failures, interruptions and unknown results retain the complete reservations.

These are explicitly **published-rate formula allowances, not an absolute supplier
invoice hard cap**. No unpublished minimum/rounding rule is invented. The ledger's
`spentMicroCny` means cumulative reserved allowance, not actual billed usage; any
free credits/shorter input do not cause refunds. Compare actual supplier usage and
invoice against reserved allowances during acceptance; record differences separately
without rewriting cumulative ledger history. Reverify prices before a later rollout.
Sources: [Alibaba model pricing](https://help.aliyun.com/zh/model-studio/model-pricing)
and [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing).
The old `APP_SHARED_ASR_FREE_STOP_VERIFIED` flag is no longer required or used.

BYOK uses the guest's own separately consented provider billing; no promise of the
owner's CNY1 allowance applies. ASR/translation remain limited per session: 60s,
1920000PCM bytes (mono16kHz/PCM16), no automatic reconnect, max40 completion attempts;
1 audio session per principal,4 app audio sessions globally,1 concurrent HTTP paid
request per principal. Authentication also has bounded global request/login rates.
These are abuse/duration limits, not a monetary cap on a guest's supplier account.

## HTTP routing and staged Access change (NOT executed here)

The wrapper must support cookies and `Set-Cookie`, forward exact Host/Origin,
not cache app-config/API responses, not log bodies, and pass real owner Access
assertions unchanged only from the trusted Access path. Forward these fixed routes:

- `GET /app-config.json` (anonymous now advertises only login/BYOK; no provider keys).
- `/api/auth/status` GET; `/api/auth/login`, `/guest`, `/logout`, `/bootstrap` POST;
  `/api/auth/accounts` GET/POST/PATCH/DELETE.
- Existing `/api/translate`, `/api/annotation`, `/api/audio-annotation` POST.
- Existing `/api/session` WebSocket Upgrade with binary forwarding.
- Owner `GET/POST /api/settings/translation-key` and `/api/settings/asr-key`.

First deploy behind current Access, let the owner securely initialize the admin,
and run synthetic account isolation/revocation tests. ONLY after the user's
specific opening approval should public static/app/auth/paid-session routes be
reachable without an Access login. Keep owner bootstrap and persistent key setting
paths under the existing Access policy. The gateway independently enforces these
owner requirements even if the wrapper misroutes a public request. An app admin
can manage users through app-role checks; it cannot use the owner key-setting path.
The old all-site owner allowlist must not be silently deleted or broadly bypassed.

A successful login/key save is not a real provider test. Production public rollout,
real passwords/keys, explicitly chosen site allowance, supplier billing and actual microphone
quality remain deployment acceptance work requiring the relevant safe inputs.
No real API calls or real audio were used for this implementation.

## Rollback

Revert matched frontend+gateway, set APP_AUTH_ENABLED=0, restore only the specifically
changed Access/wrapper rules, and retain private account and all budget/key files.
Old gateway ignores new account files. Do not delete ledgers or enlarge quotas to
make a rollback appear successful. Session restart/log-out requires signing in again.

## Protected owner page after public opening

Serve the same static entry at `/owner` and `/owner/`. Keep `/owner` and every
`/owner/*` path under the existing owner-only Access application. The UI prefixes
ALL of its fixed config/API routes while on this page: `/owner/app-config.json`,
`/owner/api/auth/*`, `/owner/api/settings/translation-key`,
`/owner/api/settings/asr-key`, and owner text/annotation/session routes. Forward
these paths unchanged to gateway; gateway normalizes the fixed namespace only
then independently verifies the owner JWT before any cookie fallback. A guest
or ordinary/admin application cookie can never promote itself with this prefix.
Public `/` remains the account/BYOK page. This is necessary because a public
app-config/status request no longer automatically receives an Access assertion.
The existing unprefixed key-setting and bootstrap routes must also remain
Access-protected. Wrapper must forward Cookie and Set-Cookie for application
sessions, and retain Host/Origin/Access assertion handling on owner paths.
