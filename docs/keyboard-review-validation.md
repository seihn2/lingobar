# Space-key caption review

This small shared-renderer fix starts from frozen PR8 source
`bff0a5bb9e638e1596fd80a13d62c7241e7f0814`. It changes keyboard review handling
in the expanded and compact readers, synthetic browser regression coverage and
this record. Audio, providers, storage, login items and Cloudflare remain unchanged.

## Reproduction and user value

Both readers already pause live following for wheel, pointer selection,
Arrow/Page/Home/End navigation. They omitted Space and Shift+Space. Chromium's
native behavior still scrolls the focused viewport by one page, but LingoBar
keeps following; the next translated caption can pull the reader away from that
position. Keyboard users cannot reliably review with those standard scroll keys.

The parent implementation fails eight checks with actual DevTools keyboard
events: in expanded and compact readers, Space and Shift+Space scroll natively,
but do not enter review or retain it when a new translated caption arrives.
Positive controls already pass for native scrolling, button activation and
modified Space. The fixture uses synthetic text and constrained overflowing
viewports; no audio, network provider or user desktop is involved.

## Change and acceptance

When the caption viewport itself has focus, unmodified Space or Shift+Space
pauses following before the native page scroll. Default scrolling is preserved.
Space on a descendant action button still activates that action, while Ctrl,
Alt, Meta, composing and already-prevented Space events are excluded from this
new pause path. Existing navigation keys and explicit Return to live remain.

The browser regression dispatches real keyDown/keyUp events with the Space
character (not only a synthetic DOM keydown). At Chromium scales1/1.5/2 it checks:

- Expanded/compact Space and Shift+Space actually scroll the overflowing viewport.
- Those actions enter review; a new translation preserves review and its position
  or selected segment. Explicit Return to live selects the latest translation.
- Ctrl+Space does not pause; Space on a focused expanded caption copy button
  still copies without pausing. The original reading, partial translation, selected
  language, ruby, search, panel focus and transparency regressions also remain.

## Official source and license

[Chromium's pinned keyboard handler](https://github.com/chromium/chromium/blob/47e2034448b867059ccf262a8d9f996c31843a38/third_party/blink/renderer/core/input/keyboard_event_manager.cc#L492-L524)
implements native Space page scrolling, reverses direction for Shift and excludes
Ctrl/Meta/Alt. This mature open-source browser provides the behavior contract;
LingoBar only needs to respect the resulting reader intent. The pinned
[BSD3-style license](https://github.com/chromium/chromium/blob/47e2034448b867059ccf262a8d9f996c31843a38/LICENSE)
was checked on2026-10-26. No Chromium source, comment or dependency is copied.
The implementation remains original project code under CC BY-NC4.0.

## Validation boundaries

Run `npm run typecheck`, `npm test`, `npm run build`, `npm run build:web`,
`npm run verify:web`, `npm run test:ui`, `npm run test:web-ui` and
`npm run test:media-permissions`. The draft PR records exact head and CI results.
Shared components are exercised by the browser fixture; production Web layout
and the Electron fake-device permission chain remain separate regressions.

This is Linux Chromium input plus synthetic captions, not native Windows/macOS
assistive-technology acceptance or iPhone/Safari hardware testing. Native IME,
actual provider latency, Workers runtime and private deployment are unverified.
Cloudflare login is not retried, and no user computer or paid API is accessed.
