# Full-source lexical text preparation

This scale batch advances from the eight-language samples to complete official
single-language exports. The raw files and prepared data stay outside Git, under
the cloud project's dictionary-data directory. No full source JSONL, SQLite
database, private data or provider credential is added to the repository.

## Reusable local preparation

```sh
node scripts/prepare-kaikki-text.cjs --input source.jsonl --output new-text.jsonl --source source-description.json
```

The source description explicitly records `url`, `edition`, `label`, `revision`,
`license`, `licenseUrl` and `attribution`. The script reads a local JSONL stream,
keeps each source row, writes a new projection and an adjacent
`new-text.jsonl.provenance.json`, and leaves the original unchanged. It refuses
to overwrite an existing output or provenance file. It has no download, model,
audio or third-party executable dependency.

The three exact non-secret source descriptions used here are checked in under
[`offline-sources/`](offline-sources/enwiktionary-ja.json):
`enwiktionary-ja.json`, `zhwiktionary-ja-hans-label.json` and
`zhwiktionary-ja-hant-label.json`. For example, prepare the matching downloaded
English-edition Japanese file with:

```sh
node scripts/prepare-kaikki-text.cjs --input source.jsonl --output new-text.jsonl --source docs/offline-sources/enwiktionary-ja.json
```

Compare the downloaded and prepared hashes with the pinned values below before
treating a later download as this same source snapshot. The script reports the
hashes; a current URL alone does not establish a matching historical snapshot.

Kept fields are `word`, `lang`, `lang_code`, `pos`, `redirects`; recorded
`forms.form` and `forms.tags`; written pronunciation fields and tags under
`sounds`; and `senses.glosses`, `raw_glosses`, `tags`, `form_of` and `alt_of`.
Linked-form objects keep only `word` and optional `extra`. The written sound
allowlist is `ipa`, `enpr`, `enPR`, `roman`, `hangeul`, `other`, `zh-pron` and
`zh_pron`. Definitions/readings are not generated or normalized.

All example/quotation branches, media/audio fields and URLs, etymology,
linkages and unrelated fields are omitted. In particular, a prepared package
does **not** claim to preserve every field or every example from the complete
source. The provenance file records the exact changes, raw/projection SHA256,
bytes, record/gloss counts, removed-example count and language inventory.
Source rows explicitly marked `no-gloss`/`empty-gloss` are not usable definitions
merely because their raw gloss contains a parenthesized category label.

## Actual sources and text projections

All three sources below were downloaded successfully on 2026-10-30. Exact URLs
are the official download links on their corresponding language pages, not
reconstructed third-party mirrors.

| Source / label | Raw bytes | Prepared bytes | Rows preserved | Rows with glosses | Glossed senses | Examples removed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| English Wiktionary / Japanese | 387568764 | 102526354 | 200030 | 145548 | 183505 | 22436 |
| Chinese Wiktionary / 日语 | 36218438 | 14473881 | 79467 | 77728 | 91637 | 3365 |
| Chinese Wiktionary / 日語 | 89915554 | 17371526 | 58060 | 43025 | 55924 | 9157 |

The gloss counts describe source fields, not semantic accuracy or distinct
vocabulary. No-source-gloss rows remain in the projection for traceability;
the pack builder reports which do not produce queryable lexical entries.

### Japanese words with English definitions

- [Official language page](https://kaikki.org/dictionary/Japanese/)
- [Exact complete JSONL](https://kaikki.org/dictionary/Japanese/kaikki.org-dictionary-Japanese.jsonl)
- Page extraction: 2026-10-25; dump: **enwiktionary 2026-10-01**.
- HTTP Last-Modified: **2026-10-25 10:46:22 GMT**.
- Raw SHA256: `986dd064355ff3a59721f5d45b396473174707c633b64b8e0eb2afa4bd9fdc89`.
- Text projection SHA256: `01ca74481c202c6fe173fed4dcad15de5925772648c2d9ca3200f993b7e597e6`.

The full source scan found 175524 distinct headwords, maximum record size87123
bytes including newline, maximum306 recorded forms and53 senses per record.
All200030 rows have `lang_code:ja`. These measured values fit the first-batch
4MiB-row/500-form/100-sense limits; they are not universal format maxima.
The maximum headword/form/gloss lengths were56/71/792 UTF16 code units.

### Japanese words with actual Chinese definitions

These are two distinct official directory-label partitions, both with
`lang_code:ja`. The source labels are retained in different package identities
and provenance rather than silently merging entries or treating one partition
as all Japanese data. The names `日语`/`日語` identify source directories; they
do not guarantee that every definition uses only simplified/traditional script.

**日语 partition**

- [Official page](https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AF%AD/index.html)
- [Exact complete JSONL](https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AF%AD/kaikki.org-dictionary-%E6%97%A5%E8%AF%AD.jsonl)
- This page states extraction **2026-10-27**, dump **zhwiktionary 2026-10-01**.
- HTTP Last-Modified: **2026-10-29 21:14:35 GMT**.
- Raw SHA256: `2a8e26dd80268c7144f9365d3d7860b70b0c8c86b9e06d5b1fc956b107680398`.
- Text projection SHA256: `e30fda7a1d948949cc1496288a6cc5ed17c79ecef0d32d3798adbd901b47574a`.

**日語 partition**

- [Official page](https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AA%9E/index.html)
- [Exact complete JSONL](https://kaikki.org/zhwiktionary/%E6%97%A5%E8%AA%9E/kaikki.org-dictionary-%E6%97%A5%E8%AA%9E.jsonl)
- This page states extraction **2026-10-27**, dump **zhwiktionary 2026-10-01**.
- HTTP Last-Modified: **2026-10-29 21:14:25 GMT**.
- Raw SHA256: `13a4f8e2d562ddb17702553033096efd5262e8d65c1299f8567f7e093b61dc2d`.
- Text projection SHA256: `37e5313030ff31182d49b2549690f97460bfc6c95251f4af906e5fef55e3e338`.

The source language-page extraction dates and HTTP modification dates are
recorded separately. They are not copied from the English-edition date or
inferred from the top-level index's later update date. Prefix inspection and
full projections verified actual Chinese glosses; no English pivot or AI
translation was used to create them.

## Source quality, licensing and reproducibility limits

Kaikki marks these complete per-language website exports as **postprocessed and
deprecated**. They are real complete downloads of those exports, not the
unprocessed bulk dump, all possible dictionary entries, or a promise that this
download interface will remain available. For later raw-input rebuilds consult
the [official raw downloads](https://kaikki.org/dictionary/rawdata.html) and
preserve each new source's own exact snapshot/hash. A matching filename or
language code is insufficient to substitute a different source version.

Dictionary text is attributed to **Wiktionary contributors**, extracted by
**Tatu Ylonen and Wiktextract contributors via Kaikki.org**. Retained dictionary
text is distributed under **CC BY-SA 4.0**, independently of LingoBar's
CC BY-NC4.0 application code. Original entries and author histories remain
available under the relevant English/Chinese Wiktionary headword pages.
See [Kaikki Chinese-edition licensing](https://kaikki.org/zhwiktionary/),
[Wiktionary copyright policy](https://en.wiktionary.org/wiki/Wiktionary:Copyrights)
and [CC BY-SA4.0](https://creativecommons.org/licenses/by-sa/4.0/).
The extractor's MIT code license is not the data license. Examples/media can
carry separate rights; their omission here is explicit, not an assertion that
every raw field is covered by the text license.

The English input contains48 raw-only senses, all explicitly tagged
`no-gloss`/`empty-gloss`; neither Chinese partition contains raw-only senses.
They must not become invented definitions from labels such as “(music)”.
Full-dataset lookup, package size, semantic/held-out coverage and native platform
acceptance belong to the scale build/validation reports, not to this preparation
step. No complete eight-language package set, hosted catalogue, real provider
acceptance or hardware performance is established by preparing these three
Japanese-source datasets.
