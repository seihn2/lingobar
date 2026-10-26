# Touch caption review validation

This small shared-renderer fix starts from frozen PR10
`83bdee1efd34c2cfd1e44aa598af7c5f75c1757e`. It changes only two viewport
pointer handlers, the Web regression fixture/driver, this record and the research
queue status. Product copy, layout, audio, provider, history persistence and
login-item policy remain unchanged.

## Reproduction

The readers already pause for wheel, keyboard navigation, scrollbar dragging and
selected text. They handle pointer-up selection but missed the pointer-cancel
event that browsers send when a touch pointer becomes native page panning.
Consequently a finger swipe can scroll while live following remains enabled;
the next translated partial/final/ruby update interrupts that reading.

[Baseline probe](https://github.com/seihn2/lingobar/actions/runs/40341277235),
test-only source `e1bcb6fabd1dfa02a591b437475072c81a84ee11`, runs the frozen
production implementation. Explicit CDP touchStart/touchMove/touchEnd frames at
375/390/860 widths move all six expanded/compact viewports about90 CSS pixels
and deliver pointercancel. Eighteen behavior checks fail: following stays active
and new partial/final/ruby updates replace the review position.

An initial high-level synthesized-gesture command did not deliver movement; it
was discarded as defect evidence. The final driver verifies touch delivery and
actual scroll displacement before asserting the application behavior. A180px
fixture viewport and long synthetic captions guarantee overflow. No real
microphone, transcript, provider, clipboard or user computer is used.

## Change and acceptance

A touch pointercancel inside either caption viewport pauses following. Mouse
cancellation is ignored. Native panning is left enabled: no preventDefault,
touch-action restriction, custom scroll implementation or gesture threshold.
A tap without panning does not take this new path.

[Fixed probe with controls](https://github.com/seihn2/lingobar/actions/runs/40342398905)
passes49 Web checks per width,147 total. It verifies:

- Actual touch movement and native scrolling, review state, and preserved scroll
  position/segment across translated partial, final and ruby updates.
- The synthetic capture session stays active while reading is paused.
- Native touch taps on Return to live restore the latest translated caption.
- The existing DOM Range plus pointer-up selection guard pauses reading and
  preserves selected synthetic text across an arrival. This is a DOM guard test,
  **not** a native Safari long-press/selection-menu test.
- Native history taps open and select a stable older segment; a later caption
  does not steal the selected segment or stop capture.
- Original source/selected language order, ruby, local search, settings focus,
  late-session isolation and zero real media/service calls remain covered.

Only after the reproducible failure was established were production handlers
changed. A temporary branch-only probe workflow was used to obtain evidence and
then removed; the final PR uses the existing Web/Worker/desktop CI workflows.

## Sources and licensing

[Able Player's pinned transcript logic](https://github.com/ableplayer/ableplayer/blob/3f174b22bd779e42db2959401f1bec003a5b2880/scripts/transcript.js#L129-L149)
distinguishes reader scrolling from programmatic auto-scroll and offers an
explicit follow control. Its [MIT license](https://github.com/ableplayer/ableplayer/blob/3f174b22bd779e42db2959401f1bec003a5b2880/LICENSE)
was checked in the [design review](upstream-design-review.md). This supplies the
behavioral design reference. The exact React pointer-cancel handler is a
LingoBar engineering choice, not copied Able Player code.

The official [W3C Pointer Events3 contract](https://www.w3.org/TR/2026/REC-pointerevents3-20260630/#the-pointercancel-event)
explains pointer-stream suppression during native panning/zooming. It is an API
reference under W3C's linked document license, not incorporated specification
text. The implementation is original CC BY-NC4.0 code; no SDK, third-party source
or new dependency is added.

## Verification boundaries

The local cloud shell returned `No usable execution environment is available`
during this batch. Source reads/writes used the authorized GitHub connector on
an isolated branch; **execution occurred in normal GitHub-hosted Linux CI**, not
a recovered local container. TypeScript, build inspection and actual headless
Chromium input with synthetic media/transports are separate layers. Exact final
head and terminal Web/Worker/Windows/macOS/UI results are recorded in the PR.

iPhone/Safari long press, selection menus, VoiceOver, native Windows/macOS touch
hardware, actual provider/audio and deployed Workers remain unverified. There
was no Cloudflare login retry, secret configuration, deployment, merge or Release.
The frozen PR3–10 snapshots and Penumbra were not modified.
