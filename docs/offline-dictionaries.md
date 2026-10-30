# Desktop offline dictionaries

This desktop draft builds on PR16 (`4113d214ff9dbd965da64da137e8a2ecfd7845b6`),
including QuickPin, frozen sentence notes, AI context explanations and personal
history/review. It does not include the separate Web/gateway branches. It adds
local dictionaries, not a new requirement to configure or call an AI service.

## Use

1. Download and extract a built language pack. In **学习历史 → 管理语言包**,
   choose **导入语言包** and select its `manifest.json`. Keep `entries.sqlite`
   beside the manifest. Each source/language pair is a separate pack.
2. In a frozen sentence detail, select a continuous original phrase, choose its
   language, and use **查询本机词典**. For copied news or a first lookup without
   any service key, use the **离线查词** entry in learning history and explicitly
   paste/type the original sentence. It never reads the clipboard in the background.
3. Choose the actual source and sense, then **收藏此义项与原句**. This saves a
   separate encounter with the frozen sentence, UTF-16 span, entry, selected sense,
   pack version, source and license. No model fills missing fields.
4. Use existing history, favorite/note edits, JSON/Markdown export and
   **复习收藏**. Recall first, then reveal and self-rate. Dictionary answers are
   absent from the review DOM before reveal. There is no automatic scheduling.

Lookup, installation, local editing, export and review do not use a network
service. The existing **解释这处用法** AI button remains separate and explicit;
it retains its own configuration, provenance and possible provider charges.

## Coverage and matching

The first delivery includes real, small Kaikki/Wiktextract-derived samples for
English, Japanese, Korean, French, German, Spanish, Russian and Chinese. These are
testable sample packs, **not complete downloadable dictionaries**. Source records,
projection rules, hashes and held-out queries are recorded in
[the data report](offline-dictionaries-data.md). The generated sample report
lists actual entries, senses, forms, hits, Chinese-gloss denominator, file sizes
and local query timings. Small warm-cache timings do not establish full-dataset
performance, linguistic accuracy, or a real-device latency guarantee.

The [next practical-size Japanese batch](offline-dictionary-scale.md) adds full
text builds of the pinned single-language English and Chinese-edition exports.
It does not turn the other seven sample languages into full-scale packs.

The engine accepts explicit language codes; it is not limited to eight hardcoded
languages. Exact headwords, Unicode NFC equivalents, supplied `forms`, and
`form_of` links to present lemmas are indexed. Match paths are shown. No generic
stemmer, invented lemma, Japanese deinflector or Korean conjugation analyzer is
included. A form absent from the imported source may have no result.

The included English-edition samples have English glosses. The app explicitly
reports missing Chinese glosses and shows each source's actual gloss language.
There is no implicit translation or English-to-Chinese pivot. Written readings
are retained when available; audio URLs are not offline pronunciation files.

## Install, update and remove

The app copies a verified pack into its existing user-data directory, then reads
the SQLite database with extensions disabled. Enable/disable choices survive
restart. A replacement of the same pack ID is copied and checked before switching
the installed registry; old connections close before old files are removed.
An already displayed lookup cannot silently save a different updated sense: it
must be queried again if the database version/hash changed.

Updating, disabling or uninstalling a pack never rewrites learning snapshots.
An old card retains exactly the chosen sense and attribution. A new lookup uses
the currently enabled version. Removal is local; it cannot withdraw already
exported files or user backups. No download service, hosting account or automatic
update channel is created in this batch.

Existing AI-only learning files remain readable without a bulk rewrite. New
offline snapshots use a distinct `offline-dictionary` provider kind; they never
claim an AI model, token usage or AI-generated example. Older application builds
that do not understand that kind may open the library read-only: retain the
newer build and a backup when evaluating a downgrade. Old subtitle favorites and
the PR15 note sidecar are unchanged.

## Build a pack locally

Use Node.js22 with built-in `node:sqlite`, or the existing Electron runtime; no
new native addon is required. The builder reads already extracted JSONL, not web
pages, and does not download source data or execute an extractor:

```sh
node scripts/build-dictionary-pack.cjs --input source.jsonl --metadata metadata.json --output new-version-directory
npm run build:dictionary-samples
```

The metadata fields are `packId`, `version`, `sourceLanguage`, `glossLanguage`,
`sourceName`, `sourceUrl`, `sourceRevision`, `license`, `licenseUrl`, and
`attribution`. Output is `manifest.json` plus `entries.sqlite`; the manifest adds
schema version, database SHA256 and counts. Use a fresh output directory.
Source entries/senses remain separate. Media, tables, etymology rendering and
arbitrary rich content are not imported. Runtime results are bounded; this first
batch does not claim tested support for every full-corpus record or GB-scale pack.

## Sources and licenses

The application source remains **CC BY-NC4.0**, source-available, not an OSI
license. The data is separately licensed and must not be relabeled as application
code. Kaikki's extracted Wiktionary text is not covered by wiktextract's code
license. Sample adaptations retain their actual source/version, attribution and
CC BY-SA4.0 terms; see the data report and each pack manifest. Exported dictionary
quotations retain those notices. User notes and source sentences are separate
from the quoted dictionary data.

Official references: [Kaikki data](https://kaikki.org/dictionary/rawdata.html),
[Wiktextract fields](https://github.com/tatuylonen/wiktextract),
[EDRDG/JMdict license](https://www.edrdg.org/edrdg/licence.html), and
[CC-CEDICT](https://cc-cedict.org/wiki/). JMdict, CC-CEDICT, FreeDict and WikDict
enhancements are not included in this first batch. No GPL Yomitan code/schema,
external dictionary executable or new package dependency is copied or installed.

## Verification boundary

The PR records exact commands, source commit, CI and sample-pack checksums.
Synthetic failure fixtures and downloaded real source samples are reported
separately. The Electron test runs the actual desktop main/preload/renderer and
SQLite/learning paths with a disposable empty profile and external requests
blocked; it never reads a user key, records audio or calls a provider.
Linux headless UI and Windows/macOS CI are not native hardware/game, keyboard
conflict, VoiceOver/NVDA or linguistic-quality acceptance. No merge, Release,
deployment or user-computer operation is part of this delivery.
