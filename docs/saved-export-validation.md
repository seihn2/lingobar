# Saved-caption export reliability

This bounded follow-up starts from PR3
`dea56eab856eb10cd0169d41211922358818b579`, with main
`857ec2c632b38b4ad50276be48524b2f8dc2571b` unchanged. It uses synthetic saved
captions, temporary directories and local browser fixtures only. No user file,
personal caption, real audio, credential, provider or user Mac is accessed.

## Reproduced problems and small fixes

1. **A useful saved translation disappeared from export during/after retry.**
   CaptionQueue deliberately retains a saved caption's previous translations
   while retrying or after a retry failure. Storage preserves those stable notes
   across restart. The history count still included them, but export required
   `status === 'ready'`: a sole pending/failed saved retry produced “save a
   sentence first”; a mixed collection could silently omit it. Export now uses
   the same saved collection. The existing save gate still prevents saving an
   unfinished live caption; a retry's valid old translation remains exportable.
2. **A late export failure appeared in an unrelated settings panel.** Export
   used the generic global action notice. Closing history and opening settings
   before a delayed rejection let that old file error enter settings; a delayed
   rejection with no dialog open could also mask the current capture error.
   Export now owns a separate pending/result state, displayed only in history.
   Closing history does not cancel the file operation or discard its result:
   reopening history shows its explicitly labelled success/failure. It never
   writes the global capture/action notice. One in-flight export disables its
   button with `aria-disabled` and a synchronous guard prevents duplicate calls
   before React paints. Keeping the busy button focusable avoids dropping
   keyboard focus; an empty collection still uses native `disabled`.

No new export format, service, file retry, destination policy or file-writing
strategy is introduced. Existing Markdown language order, original text,
available translations and Japanese readings remain unchanged. The selection
still follows the existing dialog workflow; this change does not claim a newly
defined immutable snapshot while the native dialog is open.

## Evidence and acceptance

| Check | Method and result |
| --- | --- |
| Native-dialog cancellation | Real installed main export handler, real CaptionQueue and Storage; fake dialog returns cancel with a path to an owned synthetic sentinel. Returns false, directory/sentinel/collection/saved.json unchanged, no translation call |
| Real write failure and recovery | Choose an owned temporary directory as the output file. Actual filesystem write rejects; collection and saved.json remain byte-for-byte unchanged, directory remains empty. A subsequent export to a new temporary Markdown path succeeds with original/French/English/Japanese/reading content |
| Saved retry pending/failed | Real queue retries a valid saved caption with a deferred/rejected synthetic translator. Both cases failed on the baseline's ready-only filter and now export the existing useful translation without clearing/changing retry state or persistence |
| Local result and concurrent input | Browser checks cancellation silence, saved-caption retention, one busy export, late failure outside history, current capture error, result on reopening, local successful retry, silent subsequent cancellation and zero media/provider calls |

The browser regression reproduced six baseline failures before the fix,
including duplicate submission, wrong-panel error, lost historical result,
masking the current capture error and global success feedback. The capture-error
sequence closes history before the late file rejection arrives.
Tests use plain React text rendering; synthetic error strings are not HTML.
Error/success output has alert/status semantics, and pending state reaches the
button's `aria-busy` attribute.

Run `npx vitest run test/export-saved.test.ts` for the four installed-main file
cases. The ten browser checks are part of `npm run test:ui`, alongside all
existing language/partial/history/ruby/compact/opacity/focus tests. Run the normal
`npm test`, `npm run build` and `npm run test:media-permissions` as well. Exact
head, platform skips, CI/artifact checksums and the temporary PR4 combination
are recorded in PR3. A Linux failure against an owned directory is not Windows
ACL, disk-full, native save-dialog, installation or hardware acceptance.

## Provenance, limits and stopping boundary

This is original project-local CC BY-NC 4.0 code. Existing Queue/Storage semantics
and prior tests supply the contract; no upstream code, new dependency, general
task framework, new benchmark or further project research is added.

PR4's bounded pause and audio-session ownership remain independent. Any
temporary combination is tested and discarded, never merged or packaged as a
combined preview. The [physical Mac record](macos-validation.md) still applies
only to its older tested binary; [Windows hardware acceptance](windows-validation.md)
is still pending. Windows builds remain unsigned, Mac previews ad-hoc signed and
not Apple-notarized.

This closes the identified cloud-verifiable export batch. No further feature
batch is automatically started: remaining established work is the existing
native/hardware/provider acceptance matrix and the user's review/merge/release
decisions. A passing synthetic check does not establish that every possible
filesystem or desktop failure has been exercised.
