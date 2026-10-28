# Web responsive adaptation

This batch starts at frozen PR12 `26444af95c557facca50ee50efd2934e32c0aeb8`.
It implements the separately requested phone/computer Web adaptation only.
The broader optimization and recurring tasks remain on hold. Independent PR4
pause drain and PR5 timing work are not included in this stack.

## Behavior

- Web compact navigation has 44×44 CSS-pixel targets. On coarse/no-hover input,
  controls occupy a visible row below the scrollable captions from the first
  interaction; they do not depend on hover or cover the last caption line.
  Fine-pointer hover and keyboard access remain available. Overrides live only
  in the Web stylesheet; Electron's renderer and window behavior are unchanged.
- Settings/history entry focuses the panel heading without opening a text
  keyboard. Tab enters its controls, IME Escape does not close it, and ordinary
  Escape/Return restores the invoking control. These are inline panels, not a
  newly introduced modal focus trap.
- The Web shell includes left/right safe-area padding as well as the existing
  top/bottom treatment. Search text uses 16px for readable mobile input. The
  existing viewport meta preserves pinch zoom; no zoom-disabling option is added.
- A Web-only observer sizes and offsets the fixed shell using VisualViewport
  height/offsetTop at scale1, falls back to window height without that API, and
  coalesces resize/pan events into one animation frame. It bounds transient
  invalid geometry and cleans up all listeners/styles. During pinch zoom it
  preserves the layout instead of shrinking it again.
- Below 420px visible height, an open panel temporarily omits the duplicate
  brand/footer navigation. Start/pause and Return to captions remain visible;
  the short search view hides the explanatory hint and, while typing, the filter
  toolbar so input/results retain room. Controls return when the panel closes.
  Viewport/keyboard changes never start audio, reconnect ASR, or retranslate.

These are original project changes. References are design/standards guidance,
not incorporated upstream code: [Chrome's visual/layout viewport explanation](https://developer.chrome.com/blog/viewport-resize-behavior/)
and [WCAG target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
44px is this batch's compact-navigation target; WCAG's minimum criterion is24px
with spacing/other exceptions. This is not a whole-product accessibility audit.

## Verification

The existing Web regression preserves source/selected-language order, immediate
partial translation, exact ruby, history anchors, touch review, annotation-only
retry, cancellation and fixed error boundaries. The added matrix runs at
320×568,375×812,390×844,844×390,1280×800 and1920×1080, with 24px type and eight
selected language slots, Unicode, RTL and unbroken synthetic text.

The matrix verifies first native Chromium touch on compact navigation, target
geometry, settings/history focus, trusted Tab/Escape, IME guard, simulated
keyboard shrink/pan/dismissal, document-scroll resistance, pinch preservation,
synthetic safe-area insets, visible input/results/capture controls, and no real
media/provider calls. The viewport port and safe-area CSS values are explicitly
synthetic; they do not emulate a native iPhone keyboard, notch or screen reader.
Dedicated unit cases cover unsupported API fallback, orientation, invalid
geometry, event coalescing and cleanup/late callbacks. Exact executed counts and
terminal CI/artifact provenance belong to the draft PR's final commit.

Local Linux validation passed: 652 Vitest tests plus7 reading-schedule tests,
159 Web tests (including10 viewport cases),405 desktop Chromium UI checks,
and313 Web UI checks (171 existing plus142 responsive matrix checks). Typecheck,
desktop/Web/Worker builds and the Web/Worker production inspections passed.
Synthetic insets also verify that short panels keep top/bottom protection when
the brand/footer rows are hidden. These are actual new runs for this batch;
they do not replace mobile hardware acceptance.

## Static deployment handoff

The existing Web CI produces a **backend-unconfigured** artifact with:

- `web/`: public static files, including `index.html`, assets, license notices
  and `app-config.json` exactly `{"version":1,"backend":null}`.
- `WEB-MANIFEST.json`: exact source head/tree/base and checkout provenance,
  default configuration and per-file byte/hash inventory.
- `WEB-SHA256SUMS.txt`: hashes of every public file and the manifest.

The archive step rejects a dirty checkout or a test-merge tree different from
the recorded source head. The GitHub artifact ZIP also has a downloadable SHA256
digest; independently compare that digest and the contained file inventory.
Use the extracted `web/` directory as the static document root; metadata stays
beside it. The parent deployment task owns server replacement and rollback.
This batch does not change Access/Tunnel, the domain, the Korean VM, server
credentials, ASR/translation configuration or any deployed files.

## Acceptance boundary

Linux Chromium viewport/touch/key injection, Node synthetic sessions, CI builds
and package verification are distinct from hardware acceptance. iPhone Safari
and Android Chrome still require actual rotation, browser bars, software
keyboard, pinch, safe-area and assistive-technology checks. Real microphone
permission/revocation, device/audio interruptions, online provider behavior and
Workers runtime remain unverified and are not enabled by the static artifact.

The current Web implementation captures a microphone only after explicit start
and service readiness; background/pagehide stops it. It does not provide other
apps' audio or system loopback. Browser layout adaptation does not add Electron's
WASAPI/Core Audio, dual-source capture, always-on-top transparent floating window,
tray or global shortcuts. No real audio, credentials, paid API, deployment,
merge or Release is used to validate this batch.
