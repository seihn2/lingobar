# 来源读音字段适配

本批补齐 Kaikki/Wiktextract 的 `sounds.hangeul` 和 `sounds.zh_pron`，同时保留 `tags` 和此前投影遗漏的 `raw_tags`。记音是来源记录，不是应用核实的标准发音；不会生成音频、纠正来源或调用 AI。

## 字段含义和呈现

- `hangeul` 来自官方韩语 `ko-pron__ph` 提取路径，通常带 `phonetic` 标签。例如 `공산당` 的 `공(ː)산당`、`회교` 的 `훼교` 是来源韩文记音，不是词头转换。
- `zh_pron` 是通用中文读音字段。`首頁` 同时记录普通话、粤语、客家话、闽南语等；不能将所有值标成“普通话拼音”。`大去` 的 `tōa--khì` 保留来源闽南语标签。
- `tags` 和 `raw_tags` 分别按原数组保留。`咧` 的同文本 `--le` 有不同来源标签，其中包括 `菲律賓`；这些记录不会只因文本相同而合并。

官方依据：[字段模型](https://github.com/tatuylonen/wiktextract/blob/19f9a3006a405fb7bfb40193dca41c7117a009a5/src/wiktextract/extractor/zh/models.py)、[韩语及中文读音提取实现](https://github.com/tatuylonen/wiktextract/blob/19f9a3006a405fb7bfb40193dca41c7117a009a5/src/wiktextract/extractor/zh/pronunciation.py)。这些标签也是来源断言，不代表本地语言学验证。

构建器将新增字段保存为带字段名、标签和原标签的普通字符串，沿用 `readings_json: string[]`，不新增数据库列。数组标签使用 JSON 字面形式，避免不同标签组合被简单拼接后误合并。原有 `ipa/enpr/roman/other` 字符串保持原字面；本批不补造它们此前未保存的标签。

查词、历史和揭示后的复习使用“来源读音记录（未校验）”标签，全部按纯文本显示；JSON/Markdown 导出保留记录及来源许可。复习揭示前不在 DOM 或可访问性树中放置这些答案；揭示和跳过不自动评分，自评仍由用户明确操作。

## 容量与兼容

对已下载的五个韩语／中文 RAW 文件逐行扫描，包含原标签后，实际最大不同读音数为：韩语两个来源 12/20，中文三个来源 159/254/2。所有来源均没有超过 256 条；新增来源标签字符串最长 214 个 UTF-16 单位，未超过既有持久层 1000 单位限制。此次没有下载或构建完整大词库；源文件 hash 沿用已留存下载报告，扫描没有额外重算整文件 hash。[容量报告](validation/offline-reading-bounds.json)

运行时对 manifest 1/2 仍按 100 条读音读取；超过 100 条的后续构建明确标为 **manifest 3**，允许最多 256 条。超限拒绝，不截断；不超过 100 条的包仍依义项数量使用版本 1/2。SQLite `user_version` 仍为 1。学习快照和导出保留实际版本 3；新客户端读取 1/2/3，旧 `6b41f16` 客户端会拒绝版本 3。[旧验证器实际准入检查](validation/offline-reading-compatibility.json)

旧收藏与版本 1/2 包保持兼容。降级后，旧客户端不能读取版本 3 包或含这些快照的新学习历史；原文件会保留，不能承诺完全双向兼容。

## 实际验证与数据边界

[小型真实来源 fixture](../test/fixtures/offline-readings/PROVENANCE.json) 保留具体源 URL、下载及子集 hash、原始行号和修改说明，数据许可为 CC BY-SA 4.0，归属 Wiktionary 贡献者及 Kaikki/Wiktextract 提取发布者。提取程序的 MIT 许可不是数据许可；例句／引文和媒体仍被剔除。[Kaikki 中文版许可](https://kaikki.org/zhwiktionary/)、[Wiktionary 版权政策](https://en.wiktionary.org/wiki/Wiktionary:Copyrights)

真实 RAW 子集经新投影、构建、导入和实际生产查询，再进入学习存储、JSON/Markdown、重启、卸载后快照与主动复习；`在` 的 254 条记录及末项完整保留。末项来自 Old-Chinese/Zhengzhang，不能当作现代标准音。[实际链路报告](validation/offline-reading-actual.json)

相关命令：

```sh
npx vitest run test/offline-reading-fields.test.ts test/offline-pack-builder.test.ts test/offline-packs.test.ts test/offline-text-projection.test.ts test/offline-learning.test.ts
node scripts/test-dictionary-ui.cjs --reading-fields-only
npm run build
npm run test:offline-dictionaries
```

**PR23 的八个完整词库 ZIP 保持原字节，没有重新压包、上传或改写。** 本批是源码与小型真实来源回归；旧包不会自动获得缺失读音。后续更新完整数据必须从保留的 RAW 重新投影，因为旧投影无法恢复已经丢弃的 `raw_tags`，并使用新的包版本及 checksum 单独交付。

本轮不访问用户电脑、真实录音、密钥、收费服务或生产部署。Linux Chromium/Electron 合成检查和 CI 不等于 Mac/Windows 原生设备、真实游戏、VoiceOver/NVDA 或读音质量验收。
