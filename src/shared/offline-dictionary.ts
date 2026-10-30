/** Local dictionary data has its own source/license; it is never an AI citation. */
export type OfflinePackManifest = {
  schemaVersion: 1 | 2 | 3; packId: string; version: string; sourceLanguage: string; glossLanguage: string
  sourceName: string; sourceUrl: string; sourceRevision: string; license: string; licenseUrl: string; attribution: string
  dbSha256: string; counts: { entries: number; senses: number; forms: number }
}
export type OfflineSense = { id: string; glosses: string[]; tags: string[]; examples: Array<{ text: string; translation: string | null }> }
export type OfflineEntry = {
  id: string; headword: string; language: string; readings: string[]; partOfSpeech: string | null
  forms: Array<{ form: string; tags: string[] }>; senses: OfflineSense[]
}
export type OfflineMatchPath = 'exact' | 'nfc' | 'form' | 'nfc-form'
export type OfflineHit = { pack: OfflinePackManifest; entry: OfflineEntry; matchPath: OfflineMatchPath; matchedText: string }
export type OfflineLookupInput = { text: string; language: string; glossLanguage?: string }
export type OfflineLookupResult = { query: string; language: string; requestedGlossLanguage: string; results: OfflineHit[]; message: string }
export type OfflinePackInfo = { manifest: OfflinePackManifest; enabled: boolean }
export interface OfflineDictionaryAPI {
  list(): Promise<OfflinePackInfo[]>
  install(): Promise<{ installed: boolean; pack: OfflinePackInfo | null }>
  setEnabled(packId: string, enabled: boolean): Promise<void>
  uninstall(packId: string): Promise<void>
  lookup(input: OfflineLookupInput): Promise<OfflineLookupResult>
}
