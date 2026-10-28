import { randomUUID } from 'node:crypto'
import { renameSync, unlinkSync } from 'node:fs'
import { open } from 'node:fs/promises'
import type { DictionaryStore } from './dictionary-store'
import { dictionaryJson, dictionaryMarkdown } from './dictionary-export'

type IO = { write: (path: string, text: string) => Promise<void>; rename: (from: string, to: string) => void; remove: (path: string) => void }
const io: IO = {
  write: async (path, text) => { const file = await open(path, 'wx', 0o600); try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() } },
  rename: renameSync, remove: path => { try { unlinkSync(path) } catch { /* A committed/removed temporary file is absent. */ } }
}
/** The synchronous revision check + rename is the export commit linearization point. */
export async function commitDictionaryExport(store: DictionaryStore, destination: string, format: 'json' | 'markdown', transport: IO = io): Promise<{ saved: boolean; message: string }> {
  const revision = store.revision, document = store.exportSnapshot()
  const content = format === 'json' ? dictionaryJson(document) : dictionaryMarkdown(document)
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await transport.write(temporary, content)
    if (store.revision !== revision) return { saved: false, message: '导出期间学习记录已变化，未提交旧文件；请重新导出。' }
    transport.rename(temporary, destination)
    return { saved: true, message: '已导出已提交的本机学习记录；没有调用服务。' }
  } finally { transport.remove(temporary) }
}
