# No automatic launch at login

This same policy is applied independently to PR4 baseline
`e1209b5de5b1d4984ee4d01943b943a0494cb39a`, following the PR3 change from
`8f7426b9055ba0b77a88ec647a97c6760f57750a`. No PR3 search/export changes are included here. The user explicitly prohibited
LingoBar startup at login. This policy supersedes the older optional startup
feature on **both macOS and Windows**: no code path may register, enable or
restore a login item.

## What was actually observed

The separate physical Mac task reported focus, search, font-size and native
export success on `8f7426b`, then a generic `Unable to set login item` message.
Its two isolated preference profiles had `launchAtLogin:false`, and the reported
`openAtLogin` query was false. The baseline called `setLoginItemSettings` on
startup and after **every** settings save, including font/opacity changes.
With false it requested **unregistration**, not activation. Do not describe
that observation as an attempt to enable startup.

The generic log had no detailed error code. Absence of one legacy startup file
does not exclude a system main-app service registration. A later system-log
query was unavailable under the local sandbox and was stopped; actual residual
system state remains unknown. The cloud task never accesses the user Mac,
changes permissions or claims the installed app has been cleaned up.

## Final behavior

- Defaults are false. Legacy stored true is ignored when loading preferences;
  reading does not rewrite the file or call any OS login-item API. An incoming
  true request is rejected before encryption, persistence or native calls.
- Launch, font/opacity changes, pin/language/device settings and a full settings
  form never call the getter or setter. The app does not reconcile or restore
  OS login items during startup, snapshots or retries.
- Settings shows a disabled, unchecked policy control and explains that old
  OS entries need separate confirmation. Only **移除语伴登录项** (Remove
  LingoBar's login item) sends a dedicated single-field false request. It does
  not silently save other edited fields or enable capture.
- Explicit removal first checks the app's observed state. An already absent Mac
  service avoids a redundant write. Windows still requests removal by the fixed
  app ID once: its current-exe-path getter can hide an older-path entry. There
  is at most one setter call per explicit request,
  always `openAtLogin:false`, then checks the result. It never registers,
  enables, requests elevated permissions, opens system settings or retries
  automatically. A pending/unknown/ineffective result is reported, not labelled
  successful.
- Windows uses the same executable path/empty args and this app's user-scope
  `com.lingobar.app` item. An enabled machine/alias item for the same executable
  is not permission to alter it or evidence that this user's app entry remains.
  A filtered absence is not full cleanup proof: the app reports an unconfirmed
  old-path result instead of a success, even after sending the false request.
- If removal is confirmed but saving local preferences fails, the item stays
  removed. There is **no enabling compensation**. The error distinguishes the
  local file failure; subsequent ordinary settings saves do not restore startup.

The policy concerns what LingoBar creates or restores. Other startup mechanisms,
such as an independently managed system entry or restoring windows at login,
are not automatically changed by the app. Real residual removal belongs to the
separate authorized local acceptance task, not this cloud implementation.

## Verification

`test/login-items.test.ts` runs the real installed main handler and Storage
against synthetic packaged Mac/Windows Electron stubs and owned temporary
preferences. It checks default/legacy startup, unrelated full/partial saves,
rejection of new enables, explicit/idempotent removal, silent failure, thrown
or unreadable native results, pending registration, local write failure and
unrelated Windows entries. Every native setter call is asserted false.

The seven browser checks cover the non-enableable control, one focused/busy
removal request, refusal feedback, no snapshot retry, explicit retry result,
ordinary save separation and zero media/provider calls. They join the normal
reading/source/selected-language/partial/history/ruby/window regressions.
Run `npm test`, `npm run build`, `npm run test:ui` and
`npm run test:media-permissions`. Exact-head CI, temporary PR4 combination and
artifact provenance/checksums are in PR3. Native APIs are **stubbed**, including
in Mac/Windows unit-test CI; this is not ServiceManagement/registry acceptance.

Earlier synthetic checks on the baseline reproduced unsolicited writes at
launch and ordinary saves, plus its lack of result verification. The earlier
default-false branch was an unnecessary unregister request. The stronger
no-enable rule is the user's new product requirement, not a fabricated error
code or a claim about why the OS refused that request.

## Official contracts and license

- [Electron43.8.3 app API](https://github.com/electron/electron/blob/v43.8.3/docs/api/app.md#appsetloginitemsettingssettings-macos-windows):
  false removes a login item; the setter has no success return.
- [Mac native implementation](https://github.com/electron/electron/blob/v43.8.3/shell/common/platform_util_mac.mm#L247-L266)
  and [browser wrapper](https://github.com/electron/electron/blob/v43.8.3/shell/browser/browser_mac.mm):
  native failure can be logged without a JS exception. Readback is necessary.
- [Windows implementation](https://github.com/electron/electron/blob/v43.8.3/shell/browser/browser_win.cc#L683-L753):
  exact app registration and StartupApproved state differ from aggregate
  executable startup state; only the owned item is removed.
- [Apple requires-approval definition](https://developer.apple.com/documentation/servicemanagement/smappservice/status-swift.enum/requiresapproval):
  registration can exist pending user approval; this does not establish an
  enabled item or successful removal.

Electron is already an [MIT-licensed dependency](https://github.com/electron/electron/blob/v43.8.3/LICENSE).
These are API/behavior references; no upstream code is copied. New code and tests
are original LingoBar CC BY-NC4.0 work. Signing/notarization and OS policy remain
unchanged: a CI pass cannot establish native permission behavior, and the Mac
preview remains ad-hoc signed and not Apple-notarized.
