import type { LearningRecord } from '../shared/learning'
// Quote each line so user-authored Markdown/HTML stays visibly attributable as content.
const quote = (text: string) => text.replace(/\r/g, '').split('\n').map(line => `> ${line.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join('\n')
export function learningMarkdown(id: string, records: LearningRecord[]): string {
  const record = records.find(record => record.captionId === id)
  if (!record) return ''
  return (record.phrases.length ? `\n\n短语（原文 UTF-16 范围）：\n${record.phrases.map(phrase => `${phrase.start}–${phrase.end}\n${quote(phrase.exact)}`).join('\n\n')}` : '') +
    (record.note ? `\n\n笔记：\n${quote(record.note)}` : '')
}
