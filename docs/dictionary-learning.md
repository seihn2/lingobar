# AI context explanations, personal history and active review

This desktop draft is stacked on PR15
`fb1639f079c3f695c443a87ed5bc4832cd2955c4`. It does not include PR13 Web,
PR14 VM gateway or independent PR4/5 changes. No merge, deployment or real
provider acceptance is implied. The existing CC BY-NC4.0 source-available license
is unchanged; no package, dictionary, model, font or other dependency was added.

## Use and request boundaries

1. While playing, use the existing **留句 / QuickPin**. It never opens a word card
   or activates the window. There is no automatic word lookup or screen capture.
2. Explicitly open **笔记**, add a contiguous original-text phrase, and choose
   **解释这处用法**. Before sending, the panel shows the exact phrase, frozen
   single sentence, one requested explanation language and existing provider's
   display name/model. Only those text inputs and the necessary fixed prompt are
   sent. Neighboring subtitles, audio, notes and history are never included.
3. The explanation language is independent of the1–8 subtitle languages. The
   interface says which language was requested; it cannot guarantee the model's
   language, meaning, part of speech, lemma or pronunciation is correct.
4. Every explicit new query creates a separate encounter, even for identical
   words/sentences. **重新解释** explicitly calls the service again and appends a
   version to that encounter. It does not rewrite old versions or merge lemmas.
5. **学习历史** is a separate local collection from old subtitle favorites and
   the session inbox. Search original phrase/sentence, meanings and notes; filter
   source language, provenance or favorites; use pages of at most50 entries.
   **未完成** reveals intents without saved explanations, favorites or notes.
   Nothing is silently evicted. Favorite and note actions do not request a model.
6. Explicitly enter **复习收藏**. Recall the highlighted phrase in its original
   sentence before **揭示已保存解释**, then choose **记起了**, **没记起** or
   **跳过**. Only the first two save a self-report event. Reveal, viewing, skip
   and leaving do not count. Undo targets only the most recent actual self-report
   in this review session, and is idempotent. This is not SRS, a mastery score,
   memory-rate estimate, streak or evidence of learning effectiveness.

All results visibly say **AI生成，可能不准确**. Headwords are **AI建议原形**;
examples are **AI生成例句**, never quotations from a dictionary. Reading requests
ask for the selected surface form, but the application cannot verify whether a
returned reading describes it or the suggested lemma. That uncertainty is labeled
and exported as `readingScope: requested-surface-unverified`; it never replaces
existing Japanese subtitle ruby. Unsupported readings/fields remain nullable.

**Only the explicit explanation/re-explanation button adds a service request,
which may incur provider charges.** No configuration means no request. QuickPin,
local phrase/note edits, history, search, export, favorite and every review action
add zero network requests. Normal ASR, translation, ruby and their existing
explicit retries retain their earlier behavior and possible costs. The former
PR15 “zero new learning requests” claim applies to its original local actions,
not this separately authorized explanation feature.

There is one application-wide in-flight explanation, no retry on timeout, no
background lookup, no JSON-repair request and no auto-retry after cancel/restart.
The request uses `max_tokens:1200`,25s and an actual streaming32KiB response cap.
These engineering limits are not a yuan budget or billing guarantee; usage is
recorded only when actually returned, and does not prove settlement/refund.
The real provider/model quality and whether1200 tokens suffice are unverified.
Tests use only synthetic fixtures and mocked providers; no real key was accessed.

## Strict dictionary JSON contract

“Dictionary JSON” names a format, not an authoritative data source. The exact
model object is `DictionaryModelV1` in `src/shared/dictionary-model.ts`. All keys
are mandatory; unknown keys are rejected recursively. This synthetic contract
example is not a real provider response:

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "reasonCode": null,
  "targetText": "pick it up",
  "headword": "pick up",
  "reading": null,
  "partOfSpeech": "动词短语",
  "contextMeaning": "在这句话里指拿起来。",
  "usageNote": null,
  "examples": [{"text": "Please pick up the blue box.", "translation": "请拿起蓝色盒子。"}]
}
```

- `ok`: reasonCode=null, nonempty contextMeaning; other semantic fields may be
  null. Empty strings do not stand for missing content.
- `ambiguous`: reason is ambiguous_context or not_lexical_unit. `declined`:
  unsupported_language or declined. Both require all semantic fields null while
  still echoing the exact targetText. No answer is fabricated for review.
- Reading is null or `{text,notation}`, where notation is kana, ipa,
  romanization or other. Examples are null or exactly one `{text,translation}`;
  translation may be null. An empty array is invalid.
- UTF16 limits: source2000; target/headword/reading256; POS80; meaning/usage800;
  example300/translation500. Inputs and echoes are not trimmed or normalized to
  make a mismatch pass. Invalid Unicode/control text, split graphemes, unknown
  fields, excessive nesting/bytes, nonobjects, non-JSON/fences, tools, empty
  content, non-stop or length-truncated completions are refused without repair.
- An otherwise valid example exactly copying the source becomes null with an
  application warning `example_duplicates_source`. There is no second request.
- Source is untrusted quoted data, not instructions or a trusted source claim.
  Legal JSON may still contain incorrect or injected semantics. Results use only
  plain text rendering: no HTML, Markdown, automatic links, tool execution or
  requests to model-generated URLs. Raw responses/errors/keys are not logged.

The main process adds IDs, immutable source/span, providerKind=llm-generated,
provider display label (not endpoint), model, promptVersion, timestamps, requested
language, finishReason, whitelisted actual usage and validation warnings. Models
cannot supply/overwrite application identity, source, offsets or provenance.
Each exported explanation version carries a complete independent source/span.

The existing safe HTTPS transport is reused (localhost HTTP exception, no URL
userinfo/query/hash, redirects refused). Existing translation/ruby calls retain
8192 tokens,128KiB and their exact request bytes when no new options are passed;
a byte-equality regression checks that compatibility.

## Source snapshots and ownership

Opening detail immediately registers a main-owned immutable snapshot in the same
user event. It is not registered only after selecting a word. The main process
compares the displayed aligned source, language, source type and source-only
version against its current paired source. Late translations/ruby and a growing
untranslated tail cannot invalidate an otherwise identical aligned source.
A race changing the actual source fails closed: reading/drafts remain, explanation
is disabled until the sentence is explicitly selected again. No automatic downgrade
to user-input or fallback to another caption occurs.

One random opaque handle belongs to one webContents/detail. It survives blur or
minimization and already registered snapshots survive later ASR revisions/queue
eviction. Leaving/changing detail, reload/crash or window destruction releases it;
a history handle is also revoked before deletion. Releasing a handle does not
cancel an explicitly dispatched request: its result belongs only to that encounter,
never a later span/view, and never opens/focuses a window. Compact mode has no
direct explanation action; it retains QuickPin and explicit expanded detail.

Provenance is intentionally limited:

| Source | Meaning |
| --- | --- |
| main-verified | Matches the application's internal aligned source at registration; not proof the ASR/audio/text is correct |
| saved-favorite | Taken from a subtitle favorite; no claim about its historical screen/audio alignment |
| user-input | Explicit text input; reopening learning history never upgrades it to main-verified |

Source/display version fields, when applicable, are bounded SHA256 digests of
application identity strings. Source-only agreement is the handle check;
displayedVersion records a display signature, not a certification of changing
translations. A handle is not a cryptographic proof of spoken content.

## Local library and failure handling

`dictionary-learning-v1.json` is separate plaintext in the existing private app
user-data directory. It stores encounters, append-only explanations/attempts and
review events. Querying never writes `saved.json` or `learning-v1.json`; unfavoriting
old subtitles/queue eviction does not erase this library, and deleting a learning
entry does not remove the old subtitle favorite. Existing files are not migrated.
The UI distinguishes subtitle notes from independent query notes.

Bounds:5000 encounters,20 explanation versions and50 attempts per encounter,
4000 UTF16 units per note,32MiB serialized library,50,000 review events total and
500 per encounter. Every pending attempt logically reserves128KiB in every commit,
so other edits cannot consume its completion headroom. This is not physical disk
space reservation. Full/unwritable/unknown-schema libraries refuse requests before
fetch; there is no silent deletion of older failures/versions to continue.

Writes are synchronous serialized transactions using a private temp file, fsync
and rename; memory updates only after success. Concurrent on-disk generation
changes, corruption, unreadability or future schemas are not overwritten. Old
saved collections remain readable. Damaged originals are preserved for recovery.
These protections are not a promise against every hardware/power-loss failure.

| Stage/result | Behavior |
| --- | --- |
| Persist encounter + not_started attempt fails |0 explanation requests |
| Persist may_have_started flag fails |0 explanation requests; intent remains manageable |
| may_have_started persisted | May have sent/billed, even if a crash occurred before fetch; no certainty of cost |
| Waiting | Exactly one mock/live transport invocation per explicit operation; no automatic retries |
| Ready/Ambiguous/ModelDeclined | Valid structured result and terminal attempt committed together |
| ReadyUnsaved | Valid response only in memory; **重试保存** never calls the model again; explicit discard/normal quit warns of loss |
| SchemaError/ServiceError | Failure recorded when writable; explicit retry only |
| Cancelled | Generation revoked before abort; late success cannot overwrite it; stopping waiting is not a refund |
| Restart | Unfinished intents become Interrupted, never resent; failed recovery write leaves original read-only with a visible warning |

Deletion revokes old generations/handles and unsaved write eligibility before abort
and atomic cascading removal. Failed disk deletion says **未删除** and can be
explicitly retried. No old callback/retry-save recreates the removed encounter.
Successful removal includes its explanations, attempts and review history; no
hidden body tombstone or orphan review total remains.

JSON and Markdown exports use only committed data. Pending appended versions do
not hide earlier committed explanations; favorite/note-only entries have an
explicit unexplained section. ReadyUnsaved content is excluded. A generation
change/deletion before export commit cancels the temporary export rather than
publishing stale content. Markdown dynamic text stays in code blocks, including
all line boundaries, so CommonMark/GFM cannot turn it into images, links, HTML or
autolinks. Arbitrary viewers that reinterpret code text are outside this guarantee.
Already completed exports/backups cannot be withdrawn; deletion is not forensic
erasure of disks, filesystem journals or user copies.

## Design references and licensing

The user/parent completed the research and two actual Opus discussions before
implementation. This batch independently implements mechanisms; no upstream code,
schema source, dictionary dataset or media was copied/imported.

- [Anki study flow](https://docs.ankiweb.net/manual/studying): recall, reveal, then
  self-report. Scheduling/FSRS is not adopted. Unlike its documented retained
  collection-wide history after [note deletion](https://docs.ankiweb.net/manual/stats#more),
  LingoBar explicitly cascades review deletion. Anki's AGPL code is not reused.
- [Lute's manual](https://luteorg.github.io/lute-manual/usage/ankiexport/index.html):
  reading status is separate from flashcard review; it delegates cards to Anki.
  No Lute/Anki exporter is implemented here. Lute code is MIT; none is copied.
- [Yomitan dictionary format](https://github.com/yomidevs/yomitan/blob/master/docs/making-yomitan-dictionaries.md):
  structured dictionary data can include rich/media/CSS content. JSON is not
  automatically safe. No GPL implementation/schema source or importer is copied.
- [EDRDG license](https://www.edrdg.org/edrdg/licence.html): JMdict Japanese/English
  components have CC BY-SA4.0 terms; other languages need separate checks.
  [WordNet's license](https://wordnet.princeton.edu/license-and-commercial-use)
  also has its own notices. Neither dataset/provider is bundled or claimed as
  the source of generated content.
- [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode/) documents
  empty/truncated output risks. A provider format setting is not local validation.

**Offline dictionary/Yomitan import is not delivered.** Only the generated
provider interface is reserved for later extension. Also excluded: lemma merging,
audio/TTS, OCR/hooks, browser extensions, clipboard monitoring, Anki/sync, FSRS,
auto-reminders, cloud sync, telemetry and new collection permissions.

## Verification scope

Tests exercise exact model/status/null/Unicode/byte/finish/tool rules, request
bytes/limits, source handles and provenance, two durable dispatch phases, failed
and interrupted writes, reservation, late responses, deletion, paging and safe
export linearization. The independent review state machine checks idempotent
ratings/undo, actual revealed versions, wrong sessions, write failure and deletion
cursor restoration. All providers/fetch/sockets are mocked or locally synthetic;
no user keys, personal captions or real devices are read.

`npm run test:dictionary-ui` uses installed Chromium at scale1/1.5/2 with external
HTTP blocked, actual App/Study integration and a full accessibility-tree probe.
Before reveal, history/detail/explanation answer DOM is absent and forbidden
answer/note/reading/example strings are absent from exposed AX names/values.
This is not VoiceOver/NVDA acceptance. Existing subtitle UI, QuickPin, session
inbox,1–8 languages, partial translation, ruby, follow/review/compact and Web
regressions are retained. Exact command/count/head/CI evidence belongs to the PR.

Native Mac/Windows focus, shortcut conflicts and actual games, real provider
compatibility/quality and offline dictionaries remain unverified. CI packaging,
Linux Chromium/AX and Electron fake-device tests do not replace hardware tests.
No real paid request, secret migration, deployment, merge or Release occurs here.
