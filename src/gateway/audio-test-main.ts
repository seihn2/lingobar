import { runAudioOnce, type AudioOnceOptions } from './audio-test'

/** Paths and explicit execution flags only; keys are never accepted as CLI arguments. */
async function main(): Promise<void> {
  const options: AudioOnceOptions = {}
  const args = process.argv.slice(2), paths: Record<string, keyof AudioOnceOptions> = {
    '--ledger-directory': 'ledgerDirectory', '--asr-key-file': 'asrKeyFile', '--translation-key-file': 'translationKeyFile', '--pcm-file': 'pcmFile'
  }
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) throw new Error(); seen.add(arg)
    if (arg === '--execute') options.execute = true
    else if (arg === '--confirm-synthetic-audio') options.confirmSyntheticAudio = true
    else if (arg === '--dry-run') options.execute = false
    else if (Object.hasOwn(paths, arg) && args[i + 1] && !args[i + 1].startsWith('--')) Object.assign(options, { [paths[arg]]: args[++i] })
    else throw new Error()
  }
  if (seen.has('--execute') && seen.has('--dry-run')) throw new Error()
  const abort = new AbortController(), cancel = () => abort.abort()
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    const result = await runAudioOnce(options, { signal: abort.signal })
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = result.status === 'completed' || result.status === 'dry-run' ? 0 : result.status === 'blocked' ? 2 : 3
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}
void main().catch(() => { process.stdout.write('{"status":"blocked","reason":"invalid-runner-arguments-or-local-state"}\n'); process.exitCode = 2 })
