import { constants, openSync, closeSync, fstatSync, fchmodSync, lstatSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, basename, join, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

export function validTranslationKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{16,2048}$/u.test(value)
}

/** Explicit owner save to one server-configured location; never returns/logs key data. */
export function saveTranslationKey(filename: string, apiKey: string): void {
  if (!isAbsolute(filename) || !validTranslationKey(apiKey)) throw new Error('Translation credential unavailable')
  const directory = dirname(filename), name = basename(filename)
  let descriptor: number | undefined, directoryFd: number | undefined
  let temporary: string | undefined
  try {
    const parent = lstatSync(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077 || parent.uid !== process.geteuid?.()) throw new Error()
    directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const opened = fstatSync(directoryFd)
    if (opened.dev !== parent.dev || opened.ino !== parent.ino) throw new Error()
    temporary = join(directory, `.${name}-${randomUUID()}.tmp`)
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, JSON.stringify({ apiKey }) + '\n'); fsyncSync(descriptor)
    closeSync(descriptor); descriptor = undefined
    renameSync(temporary, filename); temporary = undefined
    fsyncSync(directoryFd)
  } catch { throw new Error('Translation credential unavailable') }
  finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (directoryFd !== undefined) closeSync(directoryFd)
    if (temporary !== undefined) { try { unlinkSync(temporary) } catch {} }
  }
}
