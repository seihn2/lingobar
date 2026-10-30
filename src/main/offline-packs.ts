import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OfflineEntry, OfflineHit, OfflineLookupInput, OfflineLookupResult, OfflinePackInfo, OfflinePackManifest, OfflineSense } from '../shared/offline-dictionary'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const MAX_PACK_BYTES = 2 * 1024 * 1024 * 1024
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000\u0008\u000b\u000c]/u.test(value)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const fail = (): never => { throw new Error('语言包格式或校验不正确，未安装。') }
const clone = <T>(value: T): T => structuredClone(value)

export function validateOfflineManifest(value: unknown): OfflinePackManifest {
  if (!object(value)) return fail()
  const keys = ['schemaVersion', 'packId', 'version', 'sourceLanguage', 'glossLanguage', 'sourceName', 'sourceUrl', 'sourceRevision', 'license', 'licenseUrl', 'attribution', 'dbSha256', 'counts']
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.schemaVersion !== 1 || !text(value.packId, 100) || !ID.test(value.packId) || !text(value.version, 100) ||
    !text(value.sourceLanguage, 40) || !LANGUAGE.test(value.sourceLanguage) || !text(value.glossLanguage, 40) || !LANGUAGE.test(value.glossLanguage) ||
    !text(value.sourceName, 2000) || !text(value.sourceUrl, 2000) || !text(value.sourceRevision, 2000) || !text(value.license, 2000) || !text(value.licenseUrl, 2000) || !text(value.attribution, 16000) ||
    typeof value.dbSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.dbSha256) || !object(value.counts) || Object.keys(value.counts).length !== 3) return fail()
  for (const key of ['entries', 'senses', 'forms']) if (!Number.isSafeInteger(value.counts[key]) || Number(value.counts[key]) < 0 || Number(value.counts[key]) > 100_000_000) return fail()
  if (Number(value.counts.entries) < 1 || Number(value.counts.senses) < 1) return fail()
  for (const field of ['sourceUrl', 'licenseUrl']) {
    let url: URL
    try { url = new URL(value[field] as string) } catch { return fail() }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return fail()
  }
  return clone(value) as unknown as OfflinePackManifest
}

/** Hash in bounded chunks so importing a real multi-language pack does not load it all into memory. */
function fileHash(path: string): string {
  const file = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
  try { let count: number; while ((count = readSync(file, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)) }
  finally { closeSync(file) }
  return hash.digest('hex')
}
function readManifest(path: string): OfflinePackManifest {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return fail()
  return validateOfflineManifest(JSON.parse(readFileSync(path, 'utf8')))
}
function database(path: string, manifest: OfflinePackManifest): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON')
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) return fail()
    for (const name of ['entries', 'senses', 'forms']) {
      if (db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name)?.type !== 'table') return fail()
      const count = db.prepare(`SELECT count(*) AS n FROM ${name}`).get()?.n
      if (count !== manifest.counts[name as keyof OfflinePackManifest['counts']]) return fail()
    }
    db.prepare('SELECT id,headword,headword_nfc,language,readings_json,pos,forms_json FROM entries LIMIT 0').all()
    db.prepare('SELECT id,entry_id,glosses_json,tags_json,examples_json FROM senses LIMIT 0').all()
    db.prepare('SELECT form,form_nfc,entry_id,tags_json FROM forms LIMIT 0').all()
    return db
  } catch (error) { db.close(); throw error }
}
type Installed = { directory: string; enabled: boolean; manifest: OfflinePackManifest }

/** Local package installation and read-only SQLite lookup. No fetch, URLs, provider or audio path. */
export class OfflinePacks {
  private installed: Installed[] = []
  private connections = new Map<string, DatabaseSync>()
  private _warning = ''
  private closed = false
  private registry: string
  get warning(): string { return this._warning }
  constructor(private directory: string) {
    this.registry = join(directory, 'installed.json')
    if (!existsSync(this.registry)) return
    try {
      if (lstatSync(this.registry).size > 1024 * 1024) throw new Error('registry size')
      const value: unknown = JSON.parse(readFileSync(this.registry, 'utf8'))
      if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).length !== 2 || !Array.isArray(value.packs) || value.packs.length > 100) throw new Error('registry')
      const ids = new Set<string>()
      this.installed = value.packs.map(raw => {
        if (!object(raw) || Object.keys(raw).length !== 3 || typeof raw.enabled !== 'boolean' || !text(raw.directory, 100) || !/^[a-f0-9-]{36}$/.test(raw.directory)) throw new Error('pack record')
        const manifest = validateOfflineManifest(raw.manifest)
        if (ids.has(manifest.packId)) throw new Error('duplicate pack')
        ids.add(manifest.packId)
        return { directory: raw.directory, enabled: raw.enabled, manifest }
      })
    } catch { this.installed = []; this._warning = '语言包安装记录无法读取，已保留原文件；未自动重建。' }
  }
  private usable(): void { if (this.closed) throw new Error('本地词典已关闭。') }
  private writable(): void { this.usable(); if (this._warning) throw new Error(this._warning) }
  list(): OfflinePackInfo[] { this.usable(); return this.installed.map(({ manifest, enabled }) => ({ manifest: clone(manifest), enabled })) }
  private commit(next: Installed[]): void {
    this.writable()
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const tmp = join(this.directory, `registry-${randomUUID()}.tmp`), file = openSync(tmp, 'wx', 0o600)
    try {
      try { writeFileSync(file, JSON.stringify({ schemaVersion: 1, packs: next }, null, 2)); fsyncSync(file) }
      finally { closeSync(file) }
      renameSync(tmp, this.registry); this.installed = next
    } finally { rmSync(tmp, { force: true }) }
  }
  install(manifestPath: string): OfflinePackInfo {
    this.writable()
    if (typeof manifestPath !== 'string') return fail()
    let manifest: OfflinePackManifest
    try { manifest = readManifest(manifestPath) } catch { return fail() }
    const source = join(dirname(manifestPath), 'entries.sqlite'), stat = lstatSync(source)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 512 || stat.size > MAX_PACK_BYTES) return fail()
    const previous = this.installed.find(pack => pack.manifest.packId === manifest.packId)
    if (!previous && this.installed.length >= 100) throw new Error('已安装语言包达到上限，请先卸载不用的语言包。')
    const child = randomUUID(), target = join(this.directory, child)
    mkdirSync(target, { recursive: true, mode: 0o700 })
    let checked: DatabaseSync | undefined
    try {
      const path = join(target, 'entries.sqlite')
      copyFileSync(source, path)
      if (fileHash(path) !== manifest.dbSha256) return fail()
      checked = database(path, manifest); checked.close(); checked = undefined
      const info: Installed = { directory: child, enabled: previous?.enabled ?? true, manifest }
      writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
      this.commit([...this.installed.filter(pack => pack !== previous), info])
    } catch (error) { checked?.close(); rmSync(target, { recursive: true, force: true }); throw error }
    // The registry now points only to the checked copy. Release handles before cleaning old files (Windows).
    if (previous) { this.disconnect(previous.directory); try { rmSync(join(this.directory, previous.directory), { recursive: true, force: true }) } catch { /* Inactive old files can be removed by the user after another process releases them. */ } }
    return { manifest: clone(manifest), enabled: previous?.enabled ?? true }
  }
  setEnabled(packId: string, enabled: boolean): void {
    this.writable()
    if (typeof enabled !== 'boolean' || !this.installed.some(pack => pack.manifest.packId === packId)) throw new Error('语言包不存在或启停参数无效。')
    this.commit(this.installed.map(pack => pack.manifest.packId === packId ? { ...pack, enabled } : pack))
    if (!enabled) { const pack = this.installed.find(pack => pack.manifest.packId === packId)!; this.disconnect(pack.directory) }
  }
  uninstall(packId: string): void {
    this.writable()
    const pack = this.installed.find(pack => pack.manifest.packId === packId)
    if (!pack) throw new Error('语言包不存在。')
    this.commit(this.installed.filter(item => item !== pack))
    this.disconnect(pack.directory)
    try { rmSync(join(this.directory, pack.directory), { recursive: true, force: true }) } catch { throw new Error('语言包已卸载，但旧文件被占用；请在退出占用程序后清理。') }
  }
  private disconnect(directory: string): void { this.connections.get(directory)?.close(); this.connections.delete(directory) }
  private connect(pack: Installed): DatabaseSync {
    const cached = this.connections.get(pack.directory)
    if (cached) return cached
    const db = database(join(this.directory, pack.directory, 'entries.sqlite'), pack.manifest)
    this.connections.set(pack.directory, db); return db
  }
  lookup(input: OfflineLookupInput): OfflineLookupResult {
    this.usable()
    if (!input || typeof input !== 'object' || !text(input.text, 1000) || !input.text.trim() || !text(input.language, 40) || !LANGUAGE.test(input.language) || (input.glossLanguage !== undefined && (!text(input.glossLanguage, 40) || !LANGUAGE.test(input.glossLanguage)))) throw new Error('请选择原文语言与有效的连续短语。')
    const language = input.language.toLowerCase(), preferred = (input.glossLanguage || 'zh').toLowerCase(), normalized = input.text.normalize('NFC')
    const results: OfflineHit[] = []
    const packs = this.installed.filter(pack => pack.enabled && pack.manifest.sourceLanguage.toLowerCase() === language)
      .sort((a, b) => Number(b.manifest.glossLanguage.toLowerCase() === preferred) - Number(a.manifest.glossLanguage.toLowerCase() === preferred))
    const errors: string[] = []
    for (const pack of packs) {
      if (results.length >= 30) break
      try {
        const db = this.connect(pack), seen = new Set<string>()
        // Keep both predicates as complete value-index lookups. Factoring language
        // outside OR made SQLite scan every entry of that language in real packs.
        const exact = db.prepare('SELECT rowid AS lookup_order,id,headword,language,readings_json,pos,forms_json FROM entries WHERE language=? AND headword=? ORDER BY rowid LIMIT 30').all(pack.manifest.sourceLanguage, input.text)
        const canonical = db.prepare('SELECT rowid AS lookup_order,id,headword,language,readings_json,pos,forms_json FROM entries WHERE language=? AND headword_nfc=? ORDER BY rowid LIMIT 30').all(pack.manifest.sourceLanguage, normalized)
        const direct = [...new Map([...exact, ...canonical].map(row => [String(row.id), row])).values()]
          .sort((a, b) => Number(a.lookup_order) - Number(b.lookup_order)).slice(0, 30)
        for (const row of direct) {
          const entry = this.entry(db, row)
          if (!entry.senses.length || seen.has(entry.id)) continue
          seen.add(entry.id); results.push({ pack: clone(pack.manifest), entry, matchPath: entry.headword === input.text ? 'exact' : 'nfc', matchedText: entry.headword })
          if (results.length >= 30) break
        }
        if (results.length >= 30) break
        const forms = db.prepare('SELECT e.id,e.headword,e.language,e.readings_json,e.pos,e.forms_json,f.form FROM forms f JOIN entries e ON e.id=f.entry_id WHERE e.language=? AND (f.form=? OR f.form_nfc=?) LIMIT 60').all(pack.manifest.sourceLanguage, input.text, normalized)
        for (const row of forms) {
          if (seen.has(String(row.id))) continue
          const entry = this.entry(db, row)
          if (!entry.senses.length) continue
          seen.add(entry.id); results.push({ pack: clone(pack.manifest), entry, matchPath: row.form === input.text ? 'form' : 'nfc-form', matchedText: String(row.form) })
          if (results.length >= 30) break
        }
      } catch { errors.push(`${pack.manifest.sourceName} 的本地包无法查询，请重新导入。`) }
    }
    const chinese = results.some(hit => hit.pack.glossLanguage.toLowerCase().split('-')[0] === 'zh')
    const fallback = results.length && preferred.split('-')[0] === 'zh' && !chinese ? '本机已安装词库暂无中文释义，当前显示英语／原语言；具体语言见每个来源。' : ''
    return { query: input.text, language, requestedGlossLanguage: preferred, results, message: [this._warning, ...errors, fallback, !packs.length ? '尚未启用该原文语言的本地词库，请先导入语言包。' : !results.length ? '本地词库未找到该词或已收录词形；没有自动调用 AI。' : ''].filter(Boolean).join(' ') }
  }
  private entry(db: DatabaseSync, raw: Record<string, unknown>): OfflineEntry {
    const array = (value: unknown, maximum: number): unknown[] => {
      if (typeof value !== 'string' || value.length > 1024 * 1024) throw new Error('entry JSON')
      const result: unknown = JSON.parse(value)
      if (!Array.isArray(result) || result.length > maximum) throw new Error('entry array')
      return result
    }
    const strings = (value: unknown, maximum: number): string[] => { const result = array(value, maximum); if (result.some(item => !text(item, 16000))) throw new Error('entry text'); return result as string[] }
    if (!text(raw.id, 200) || !text(raw.headword, 1024) || !text(raw.language, 40) || (raw.pos !== null && !text(raw.pos, 256))) throw new Error('entry')
    const forms = array(raw.forms_json, 500).map(item => {
      if (!object(item) || !text(item.form, 1024) || !Array.isArray(item.tags) || item.tags.length > 100 || item.tags.some(tag => !text(tag, 256))) throw new Error('entry forms')
      return { form: item.form, tags: item.tags as string[] }
    })
    const senses: OfflineSense[] = db.prepare('SELECT id,glosses_json,tags_json,examples_json FROM senses WHERE entry_id=? ORDER BY rowid LIMIT 100').all(raw.id).map(sense => {
      if (!text(sense.id, 200)) throw new Error('sense')
      const examples = array(sense.examples_json, 20).map(item => {
        if (!object(item) || !text(item.text, 16000) || (item.translation !== null && !text(item.translation, 16000))) throw new Error('example')
        return { text: item.text, translation: item.translation as string | null }
      })
      return { id: sense.id, glosses: strings(sense.glosses_json, 100), tags: strings(sense.tags_json, 100), examples }
    }).filter(sense => sense.glosses.length > 0)
    return { id: raw.id, headword: raw.headword, language: raw.language, readings: strings(raw.readings_json, 100), partOfSpeech: raw.pos as string | null, forms, senses }
  }
  close(): void { for (const db of this.connections.values()) db.close(); this.connections.clear(); this.closed = true }
}
