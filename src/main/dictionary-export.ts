import type { DictionaryDocument, DictionaryExplanation, DictionaryReviewEvent, DictionarySource } from '../shared/dictionary'

const DISCLAIMER = 'AI生成，可能不准确；不是权威词典或经核实的语言事实。'
const READING_NOTICE = '已请求所选表面形式的读音，但实际对应未验证，也可能是AI建议原形的读音。'
const USAGE_NOTICE = 'usage仅记录服务实际返回的计量，不代表账单、结算金额或退款。'

/** Rebuild only the application contract; never spread a disk/provider object into export. */
function sourceCopy(source: DictionarySource): DictionarySource {
  return {
    text: source.text, language: source.language, sourceType: source.sourceType, provenance: source.provenance,
    captionId: source.captionId, displayedVersion: source.displayedVersion, sourceVersion: source.sourceVersion,
    span: { start: source.span.start, end: source.span.end, exact: source.span.exact },
  }
}
function explanationCopy(explanation: DictionaryExplanation): DictionaryExplanation {
  if (explanation.providerKind === 'offline-dictionary') return {
    schemaVersion: 1, encounterId: explanation.encounterId, explanationId: explanation.explanationId, version: explanation.version,
    providerKind: 'offline-dictionary', providerLabel: explanation.providerLabel, createdAt: explanation.createdAt,
    pack: { schemaVersion: explanation.pack.schemaVersion, packId: explanation.pack.packId, version: explanation.pack.version, sourceLanguage: explanation.pack.sourceLanguage, glossLanguage: explanation.pack.glossLanguage,
      sourceName: explanation.pack.sourceName, sourceUrl: explanation.pack.sourceUrl, sourceRevision: explanation.pack.sourceRevision, license: explanation.pack.license, licenseUrl: explanation.pack.licenseUrl, attribution: explanation.pack.attribution,
      dbSha256: explanation.pack.dbSha256, counts: { entries: explanation.pack.counts.entries, senses: explanation.pack.counts.senses, forms: explanation.pack.counts.forms } },
    entry: { id: explanation.entry.id, headword: explanation.entry.headword, language: explanation.entry.language, readings: [...explanation.entry.readings], partOfSpeech: explanation.entry.partOfSpeech, forms: explanation.entry.forms.map(form => ({ form: form.form, tags: [...form.tags] })) },
    sense: { id: explanation.sense.id, glosses: [...explanation.sense.glosses], tags: [...explanation.sense.tags], examples: explanation.sense.examples.map(example => ({ text: example.text, translation: example.translation })) },
    matchPath: explanation.matchPath, matchedText: explanation.matchedText
  }
  const content = explanation.content
  return {
    schemaVersion: 1, encounterId: explanation.encounterId, explanationId: explanation.explanationId,
    version: explanation.version, providerKind: 'llm-generated', providerLabel: explanation.providerLabel,
    model: explanation.model, promptVersion: explanation.promptVersion, createdAt: explanation.createdAt,
    requestedExplanationLanguage: explanation.requestedExplanationLanguage, finishReason: explanation.finishReason,
    usage: explanation.usage === null ? null : {
      promptTokens: explanation.usage.promptTokens, completionTokens: explanation.usage.completionTokens, totalTokens: explanation.usage.totalTokens,
    },
    readingScope: 'requested-surface-unverified',
    content: {
      schemaVersion: 1, status: content.status, reasonCode: content.reasonCode, targetText: content.targetText,
      headword: content.headword,
      reading: content.reading === null ? null : { text: content.reading.text, notation: content.reading.notation },
      partOfSpeech: content.partOfSpeech, contextMeaning: content.contextMeaning, usageNote: content.usageNote,
      examples: content.examples === null ? null : [{ text: content.examples[0].text, translation: content.examples[0].translation }],
    },
    validationWarnings: explanation.validationWarnings.filter(warning => warning === 'example_duplicates_source'),
  }
}
function reviewCopy(review: DictionaryReviewEvent): DictionaryReviewEvent {
  return { id: review.id, sessionId: review.sessionId, encounterId: review.encounterId, explanationId: review.explanationId, createdAt: review.createdAt, response: review.response }
}
function committedExport(document: DictionaryDocument) {
  const entries = document.encounters.flatMap(encounter => encounter.explanations.map(explanation => ({
    encounterId: encounter.id, createdAt: encounter.createdAt, favorite: encounter.favorite, note: encounter.note,
    source: sourceCopy(encounter.source), explanation: explanationCopy(explanation),
  })))
  const unexplainedEncounters = document.encounters.filter(encounter => !encounter.explanations.length && (encounter.favorite || encounter.note.trim())).map(encounter => ({
    encounterId: encounter.id, createdAt: encounter.createdAt, favorite: encounter.favorite, note: encounter.note,
    source: sourceCopy(encounter.source), explanationAvailable: false as const,
  }))
  const identities = new Set(entries.map(entry => JSON.stringify([entry.encounterId, entry.explanation.explanationId])))
  return {
    schemaVersion: 1 as const, kind: 'lingobar-dictionary-learning-export' as const,
    disclaimer: entries.some(entry => entry.explanation.providerKind === 'llm-generated') ? DISCLAIMER : '离线词典快照；释义来源及许可随各词条保留，不是AI生成解释。', readingNotice: READING_NOTICE, usageNotice: USAGE_NOTICE,
    offlineNotice: '离线词条保留用户选择义项时的来源、许可与版本；更新或卸载词库不改变已收藏快照。AI声明仅适用于 llm-generated 条目。',
    entries, unexplainedEncounters,
    reviewEvents: document.reviews.filter(review => identities.has(JSON.stringify([review.encounterId, review.explanationId]))).map(reviewCopy),
  }
}

/** Each entry independently carries its source/span; pending attempts do not suppress committed versions. */
export function dictionaryJson(document: DictionaryDocument): string {
  return JSON.stringify(committedExport(document), null, 2) + '\n'
}

/**
 * Every dynamic value stays in an indented code block, including every physical
 * line boundary. CommonMark/GFM therefore never parses its HTML, image/link,
 * autolink or fence syntax. This does not promise safety in arbitrary viewers
 * which deliberately reinterpret code text as active content.
 */
const block = (value: string | number | boolean | null): string => {
  const text = value === null ? '未提供' : String(value)
  return '\n' + text.replace(/\r\n|\r|\u2028|\u2029/g, '\n').split('\n').map(line => `    ${line}`).join('\n') + '\n\n'
}
const field = (label: string, value: string | number | boolean | null): string => `${label}\n${block(value)}`
const provenance = {
  'main-verified': '应用内来源核对：仅与应用内部已对齐原文一致，不保证ASR识别正确。',
  'saved-favorite': '旧字幕收藏来源：不声称已核实当时屏幕显示或语音内容。',
  'user-input': '用户主动输入：不会升级为应用内核对来源。',
} as const

export function dictionaryMarkdown(document: DictionaryDocument): string {
  const exported = committedExport(document)
  const ai = exported.entries.some(entry => entry.explanation.providerKind === 'llm-generated')
  let result = '# LingoBar 个人学习历史\n\n' + (ai ? 'AI条目声明：' + DISCLAIMER + '\n\n' + READING_NOTICE + '\n\n' + USAGE_NOTICE : '离线词典快照；每条保留收藏时的义项、来源与许可。') + '\n\n'
  for (const [index, entry] of exported.entries.entries()) {
    const { source, explanation } = entry
    result += `## 结构化词条 ${index + 1}\n\n`
    result += field('Encounter ID', entry.encounterId) + field('创建时间（Unix毫秒）', entry.createdAt)
    result += field('收藏', entry.favorite) + field('用户笔记（用户内容）', entry.note)
    result += '### 冻结原句与来源\n\n' + provenance[source.provenance] + '\n\n'
    result += field('冻结原句（原文引文）', source.text) + field('源语言（应用记录，可能为自由文本）', source.language)
    result += field('来源类型', source.sourceType) + field('原字幕 ID', source.captionId)
    result += field('显示版本', source.displayedVersion) + field('对齐源文版本', source.sourceVersion)
    result += field('选中短语（原文引文）', source.span.exact) + field('UTF-16范围（起点含、终点不含）', `${source.span.start}–${source.span.end}`)
    if (explanation.providerKind === 'offline-dictionary') {
      result += '### 离线词典义项（收藏时快照）\n\n'
      result += field('Explanation ID', explanation.explanationId) + field('提供者类型', explanation.providerKind) + field('词库来源', explanation.pack.sourceName)
      result += field('Pack ID', explanation.pack.packId) + field('词库版本', explanation.pack.version) + field('数据快照', explanation.pack.sourceRevision)
      result += field('词条语言', explanation.pack.sourceLanguage) + field('释义语言', explanation.pack.glossLanguage)
      result += field('来源 URL（纯文本）', explanation.pack.sourceUrl) + field('许可', explanation.pack.license) + field('许可 URL（纯文本）', explanation.pack.licenseUrl) + field('署名', explanation.pack.attribution)
      result += field('Entry ID', explanation.entry.id) + field('Sense ID', explanation.sense.id) + field('词头', explanation.entry.headword)
      result += field('读音（词库记录）', explanation.entry.readings.join('\n') || null) + field('词性（词库记录）', explanation.entry.partOfSpeech)
      result += field('选定义项', explanation.sense.glosses.join('\n')) + field('义项标签', explanation.sense.tags.join('\n') || null)
      result += field('命中路径', explanation.matchPath) + field('命中文本', explanation.matchedText)
      result += field('词库例句（非AI生成）', explanation.sense.examples.map(example => example.text + (example.translation === null ? '' : '\n' + example.translation)).join('\n\n') || null)
      continue
    }
    const content = explanation.content
    result += '### AI 语境解释\n\n' + DISCLAIMER + '\n\n'
    result += field('Explanation ID', explanation.explanationId) + field('解释版本', explanation.version)
    result += field('提供者类型', explanation.providerKind) + field('服务显示名', explanation.providerLabel) + field('配置模型名', explanation.model)
    result += field('Prompt版本', explanation.promptVersion) + field('解释创建时间（Unix毫秒）', explanation.createdAt)
    result += field('已请求的解释语言（不保证模型语义遵守）', explanation.requestedExplanationLanguage)
    result += field('模型状态', content.status) + field('模型原因代码', content.reasonCode) + field('模型回显短语（仅一致性检查）', content.targetText)
    result += field('AI建议原形（不用于合并遭遇）', content.headword)
    result += field('AI读音（对应对象未验证，可能是建议原形）', content.reading?.text ?? null)
    result += field('AI读音标记方式', content.reading?.notation ?? null)
    result += field('AI词性', content.partOfSpeech) + field('AI语境释义', content.contextMeaning) + field('AI用法说明', content.usageNote)
    result += '### AI生成例句（不是原句引文或真实词典例句）\n\n'
    result += field('AI生成例句', content.examples?.[0].text ?? null) + field('AI生成例句译文', content.examples?.[0].translation ?? null)
    result += field('应用校验警告', explanation.validationWarnings.length ? explanation.validationWarnings.join('\n') : null)
    result += field('完成原因', explanation.finishReason)
    result += field('服务报告usage（不是结算凭据）', explanation.usage === null ? null : JSON.stringify(explanation.usage))
  }
  result += '## 尚无已保存解释的收藏与笔记\n\n这些是已提交的用户收藏或笔记，没有已保存解释，不是生成词条，也没有可复习的答案。\n\n'
  for (const [index, entry] of exported.unexplainedEncounters.entries()) {
    const source = entry.source
    result += `### 收藏与笔记 ${index + 1}\n\n`
    result += field('Encounter ID', entry.encounterId) + field('创建时间（Unix毫秒）', entry.createdAt)
    result += field('收藏', entry.favorite) + field('用户笔记（用户内容）', entry.note)
    result += field('已有保存解释', entry.explanationAvailable)
    result += provenance[source.provenance] + '\n\n'
    result += field('冻结原句（原文引文）', source.text) + field('源语言（应用记录，可能为自由文本）', source.language)
    result += field('来源类型', source.sourceType) + field('原字幕 ID', source.captionId)
    result += field('显示版本', source.displayedVersion) + field('对齐源文版本', source.sourceVersion)
    result += field('选中短语（原文引文）', source.span.exact) + field('UTF-16范围（起点含、终点不含）', `${source.span.start}–${source.span.end}`)
  }
  result += '## 主动复习自评\n\n仅记录用户的自我报告，不表示掌握、记忆率或SRS调度。查看、揭示和跳过不算自评。\n\n'
  for (const review of exported.reviewEvents) {
    result += field('自评事件 ID', review.id) + field('本次复习会话 ID', review.sessionId)
    result += field('Encounter ID', review.encounterId) + field('被揭示的Explanation ID', review.explanationId)
    result += field('自评创建时间（Unix毫秒）', review.createdAt) + field('自评', review.response)
  }
  return result
}
