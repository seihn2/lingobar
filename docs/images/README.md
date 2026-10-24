# Screenshot provenance

`expanded.png` and `compact.png` are actual captures of LingoBar's current React
interface, produced by `npm run test:ui` from source commit `f7a64b8` on Linux
Chromium. They were copied without image editing from:

- `artifacts/ui-regression/synthetic-expanded.png`
- `artifacts/ui-regression/synthetic-compact.png`

The fixture is `test/fixtures/ui.tsx`; capture code is `scripts/test-ui.cjs`.
The UI uses synthetic original sentences and French/Japanese translations, with
Chromium device scale 2. Audio capture and service calls are disabled in that
fixture. No API keys, recordings, personal captions or user settings appear.

The fixture supplies Windows platform labels to the shared renderer. These are
browser captures of the app content, not native Windows screenshots or proof of
hardware audio, window dragging or real DPI behavior. The documentation keeps
these limits next to the images. Re-run `npm run test:ui` to regenerate evidence.
