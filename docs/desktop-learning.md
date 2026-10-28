# Desktop sentence learning (draft)

This batch is stacked on PR12 `26444af95c557facca50ee50efd2934e32c0aeb8`.
It adds desktop learning, without adopting Web-responsive/gateway changes or
independent PR4 pause-finalization / PR5 timing. Nothing is merged or deployed.
LingoBar remains source-available under CC BY-NC4.0.

## Use

- In the compact reader, **留句 / QuickPin** saves the sentence actually shown,
  including a sentence reached with previous/next. `Cmd/Ctrl+Alt+S` does the same
  while the window is visible. It does not open/focus the window or a card.
  Repeating it says “已经收藏”; it does not remove the favorite.
- In the expanded stream, use the sentence's **留句** button. A global shortcut
  does not guess between several visible rows. Ordinary bookmark toggles and the
  existing history remain available. Shortcut conflicts fall back to buttons.
- **笔记** explicitly opens a frozen source/translation/ruby view in the same
  window. Select a contiguous original phrase, then press **加入所选原文短语**;
  or enter the start/end range and add it. Add your own note and explicitly save.
  There is no generated definition, word-card popup or lemma merging.
- **会话匣** can explicitly start/end a named local session. New favorites in that
  session are associated with it; editing a saved encounter keeps its original
  association. Select an earlier session or **所有收藏（含旧收藏）** to read/edit
  existing sentences and notes. Session names come only from you. Restarting the
  app never resumes an active session automatically; earlier session items remain
  readable. No game/window title, process, browsing history or URL is inspected.
- For news, copy a sentence/paragraph yourself and use **输入文字翻译**. Paste up
  to5000 characters and submit explicitly, then save the completed sentence.
  LingoBar does not watch the clipboard or inspect browser pages.
- Close/Escape/view changes protect edited drafts with **继续编辑** or
  **放弃草稿并离开**. Blur never saves. Pending writes finish before navigation;
  editing is disabled during them. There is one in-memory draft, no draft file.
  Quitting the app discards it. Returning restores only LingoBar's own reading
  position/focus, never an external game's OS focus.
- Copy in detail copies only the frozen original; ruby and translations do not
  alter it. Existing Markdown export includes attached phrases and notes without
  translating or annotating again. Deleting notes retains the ordinary sentence;
  unfavoriting removes it from active saved views and subsequent exports.

QuickPin refuses incomplete/live/pending/error sentences, stale display revisions,
preview, absent/evicted targets and hidden/minimized windows. It never falls back
or queues an eventual save. A retained old row can still be opened in memory, but
cannot be persisted after leaving the active queue. Errors distinguish incomplete,
changed target, full collection and storage failures. A sidecar failure can leave
**the sentence saved while its note/session metadata was not saved**.

The detail view is frozen only for the current opening. Ordinary saved translations
can still change through existing explicit retries. Background ASR can continue;
new captions do not replace the frozen draft. A source change while editing refuses a stale save and retains the draft for
review. Existing favorites may save source-identical notes after a late ruby
completion, without replacing the frozen display; a new QuickPin still requires
the exact displayed revision. No assurance
is made for exclusive fullscreen/protected games. Silent, non-copyable game text
is outside this version; system audio/ASR is the existing audio route.

## Data and safety contract

- `saved.json` stays the existing favorite format and authority. It is not
  migrated/re-written merely by opening study UI. Older versions can still read it.
- `learning-v1.json` schema1 contains allowlisted local session metadata, saved
  caption IDs/timestamps, SHA256 of source/language/original, UTF16 phrase ranges,
  exact selected phrase text and notes. It stores no recordings, complete partial
  stream, credentials or persistent drafts. It is local plaintext, like existing
  saved captions: protect the user-data directory and exported files accordingly.
- A phrase uses UTF16 code units (`start` inclusive, `end` exclusive), must exactly
  equal `original.slice(start,end)` and begin/end at grapheme boundaries. Limits:
  20 phrases/sentence,1000 units/phrase,2000 units/note,1000 records,100 sessions.
  These are application bounds, not provider quotas. Sessions at capacity are not
  silently deleted; new session creation reports the limit.
- DOM mapping counts original nodes only, excluding `rt`/`rp`, controls and hidden
  annotation nodes. It rejects unmappable selections, split emoji/ZWJ/combining
  sequences and mismatched source text. Repeated text is located by DOM offsets.
- Caption ID, not text hash, identifies an encounter. Different IDs with equal
  text remain separate. Source mismatch makes old metadata **unanchored**, without
  applying its offsets; new bindings require original and translated source to
  align. Orphans never enter active views/exports and are cleaned on a later
  explicit writable transaction.
- Ordinary favorite writes happen first, then metadata. Synchronous main-process
  transactions serialize updates; a changed on-disk generation is refused instead
  of overwriting another writer or newer schema. Metadata uses a private temporary file, fsync,
  then rename; memory changes only after successful commit. A failed/interrupted
  pre-rename write preserves the previous document. This is process-interruption
  protection, not a guarantee against every filesystem/power-loss scenario.
- Corrupt/unreadable or unknown-schema metadata is read-only and never overwritten.
  Existing favorites remain usable. No unknown disk object is forwarded to UI.
  Removal failures are explicit; inactive orphan data is excluded even when a file
  cannot be updated. This is not forensic erasure of disks/backups or past exports.
- All new IPC uses the existing trusted main-frame gate and fixed allowlist.
  Learning adds **zero provider/audio requests, permissions or dependencies**.
  Existing explicitly requested ASR/text translation/ruby/retries keep their
  existing behavior and possible provider costs. No actual paid request ran here.
  Login-at-start remains prohibited and untouched.

## Design provenance

These are independently implemented interaction/data contracts, not copied code.
The parent completed the research and actual Opus5.5 discussion before this batch;
model agreement is not acceptance evidence.

| Official project | License | Concrete lesson used here | Deliberate boundary |
| --- | --- | --- | --- |
| [Yomitan](https://github.com/yomidevs/yomitan) | GPL-3.0-or-later | Explicit context selection and deliberate lookup | No scanner, dictionary or copied implementation |
| [asbplayer](https://github.com/asbplayer/asbplayer) | AGPL-3.0-or-later; some portions MIT | Preserve a whole encountered sentence/context | No copied code, media/Anki or automatic card creation |
| [LunaTranslator](https://github.com/HIllya51/LunaTranslator) | GPLv3 | Respect capture and revision boundaries | No game hook/injection/process access |
| [Lute v3](https://github.com/LuteOrg/lute-v3) | MIT | Multiword phrases in original context | No full reader or language-model/dictionary dependency |
| [Pot](https://github.com/pot-app/pot-desktop) (archived) | GPL-3.0-only | Explicit invocation and platform boundaries | No new foundation/dependency |

## Verification and limits

`test/learning.test.ts`, `learning-compat.test.ts` and installed IPC/export tests
exercise idempotence, displayed identity, hidden/minimized/stale/incomplete targets,
1000-favorite cap, rollback, interrupted/failed metadata commits, schema protection,
source anchoring, delete/export and downgrade/upgrade compatibility with temporary
synthetic files. No personal saved library is opened.

`test/fixtures/ui.tsx` runs the actual renderer in installed Linux Chromium:
non-tail compact cursor; repeated pin; no automatic panel/focus; frozen source and
selected translation/ruby under20 new captions plus same-ID revision; IME/Escape,
draft discard, blur, stale save, deletion, internal focus/cursor restoration and
late error ownership; cross-node/ruby/Japanese/repeated-word/emoji mapping.
Synthetic provider/audio counters before/after the same fixture remain unchanged.
The existing explicit text-submit handler and provider queue are not modified.

Compared with the existing history/manual-translation/bookmark route, QuickPin
needs **one button or shortcut action**, opens zero panels and makes zero focus
calls; deeper learning remains an explicit second action. Return from compact
study takes one close action when clean (dirty drafts require a deliberate choice).
Unit main-process spies verify no show/focus/media/key-access calls for learning.
Browser tests verify no internal focus movement on a pin completion. These are
synthetic operation counts, not a human study or real-game interruption rate.

Commands: `npm test`, `npm run build`, `npm run test:ui`,
`npm run test:media-permissions`, `npm run test:web`, `npm run build:web`,
`npm run verify:web`, `npm run test:web-ui`. Exact counts, head and CI links belong
in the draft PR after execution. No historical test result is a new run.

Native Mac/Windows focus, OS shortcut conflicts, game compatibility, native drag,
real audio/services and VoiceOver/NVDA remain unverified for this batch. Linux
Chromium/Electron synthetic tests and platform CI builds do not replace hardware
acceptance. Web/gateway runtime and the1yuan test allowance remain untouched.
