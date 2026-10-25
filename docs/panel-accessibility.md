# Panel keyboard and accessibility regression

This batch starts from PR3 `39c6ba52c6921b69da47dafa8d8ecddceda46277`.
It changes renderer focus management and existing button state semantics only.
No audio, provider, storage, native helper, window-visibility or signing code
is changed. PR3 remains separate from PR4; no physical Mac or Windows session
is run by this cloud batch.

## Reproduced problems

The real renderer in Linux Chromium reproduced nine failed assertions before
the fix, using synthetic captions and fake device enumeration:

- Opening settings from compact mode destroys its original trigger during
  expansion. Escape could leave focus on BODY because the focus effect captured
  the invoker too late, with no equivalent-control fallback.
- The text panel's textarea autofocus ran before the parent focus effect.
  Closing it, or switching to Find, could try to restore a removed textarea.
  Find from compact reading similarly lost its removed reading-surface origin.
- Removing a focused selected-language chip removed that button without moving
  focus to a surviving control.
- Three settings navigation buttons and two history filters exposed their
  names but only CSS indicated the current selection. An independent browser
  accessibility-tree inspection confirmed no pressed/current/selected state.

The existing expanded-history Escape return, dialog names, field names and IME
guards already worked; they were retained. The nine baseline failures were
recorded in `/tmp` during development, not uploaded with private machine data.

## Change and acceptance

| Change | User value | Acceptance |
| --- | --- | --- |
| Capture the outside invoker before opening/expanding | Closing a panel does not strand keyboard users after its trigger or an autofocus child disappears | Settings Escape/close/save, compact settings/Find, text Escape, text→Find and repeated Find restore a live invoker or the equivalent expanded control |
| Restore only when the panel closes | Switching between panels does not briefly restore an obsolete trigger or overwrite the original workflow origin | Focus enters the new named dialog; normal and trusted-browser Tab/Shift+Tab stay inside; IME Escape does not close settings |
| Focus the stable language option before removing its selected chip | A removed control does not strand focus; the language can be re-added immediately | Focused French removal lands on its option, can re-add it, and keeps the minimum-language constraint |
| Expose current navigation/filter state with `aria-pressed` | Assistive technology can distinguish the current settings section and history filter | All five controls have matching true/false states in the actual browser accessibility tree; names and native button keyboard behavior remain |

All existing subtitle tests remain: selected languages and originals, partial
updates, latest readable translation, review/follow anchors, ruby above matching
kanji, compact reading, opacity, safe text, late translation and IME guards.

## Evidence and limits

Run `npm run test:ui`. Each scale 1/1.5/2 executes **85 checks**: the previous
62, nineteen panel-focus/state regressions and four actual accessibility-tree
and trusted-browser Tab checks. The original baseline failed nine new checks;
the final renderer passes them. `Accessibility.getFullAXTree` inspects actual
pressed states rather than assuming DOM attributes reach assistive technology.
`Input.dispatchKeyEvent` tests real browser Tab defaults in addition to the
existing synthetic key-event guards.

The fixture replaces device enumeration with an empty synthetic list and rejects
media startup/provider calls. It does not inspect a real device or call an API.
Artifacts contain synthetic UI checks, not personal captions or credentials.
Browser keyboard/AX results do not establish VoiceOver/NVDA behavior, native
IME, global shortcuts or physical Mac/Windows focus behavior. The physical Mac
record still applies only to the older [796a1aa preview](macos-validation.md).
This batch does not resolve its uncertain hide/settings/quit observations.

## Design sources and license

The implementation is original LingoBar code under CC BY-NC 4.0, with no new
dependency or copied third-party example. Existing local history research is
recorded in [optimization-2026-10.md](optimization-2026-10.md); it was not repeated.

The behavioral references are W3C's official
[Dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) for
contained tab navigation and logical return focus, and
[Button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/) for toggle
state. Copyright © 2026 World Wide Web Consortium; their footer links the
[W3C Software and Document License 2023](https://www.w3.org/copyright/software-license-2023/).
These are design-contract references, not incorporated implementation or
modified W3C documents. Existing GPL/AGPL research code remains excluded.
