/** Public routing metadata only. Provider credentials never belong in this file. */
export type AudioStatus = 'ready' | 'disabled' | 'missing-key' | 'budget-unverified' | 'quota'
interface WebConfig { backend: '/api/session' | null; textBackend?: '/api/translate' | null; credentialsBackend?: '/api/settings/translation-key' | null; asrCredentialsBackend?: '/api/settings/asr-key' | null; audioStatus?: AudioStatus }
export function parseWebConfig(value: unknown): WebConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('网页配置格式不正确。')
  const input = value as Record<string, unknown>
  if (input.version !== 1 || Object.keys(input).some(key => !['version', 'backend', 'textBackend', 'credentialsBackend', 'asrCredentialsBackend', 'audioStatus'].includes(key)) || (input.backend !== null && input.backend !== '/api/session') ||
    (Object.hasOwn(input, 'textBackend') && input.textBackend !== null && input.textBackend !== '/api/translate') ||
    (Object.hasOwn(input, 'credentialsBackend') && input.credentialsBackend !== null && input.credentialsBackend !== '/api/settings/translation-key') ||
    (Object.hasOwn(input, 'asrCredentialsBackend') && input.asrCredentialsBackend !== null && input.asrCredentialsBackend !== '/api/settings/asr-key') ||
    (Object.hasOwn(input, 'audioStatus') && !['ready', 'disabled', 'missing-key', 'budget-unverified', 'quota'].includes(input.audioStatus as string))) throw new Error('网页配置格式不正确。')
  return { backend: input.backend, ...(Object.hasOwn(input, 'textBackend') ? { textBackend: input.textBackend as WebConfig['textBackend'] } : {}),
    ...(Object.hasOwn(input, 'credentialsBackend') ? { credentialsBackend: input.credentialsBackend as WebConfig['credentialsBackend'] } : {}),
    ...(Object.hasOwn(input, 'asrCredentialsBackend') ? { asrCredentialsBackend: input.asrCredentialsBackend as WebConfig['asrCredentialsBackend'] } : {}),
    ...(Object.hasOwn(input, 'audioStatus') ? { audioStatus: input.audioStatus as AudioStatus } : {}) }
}
export async function loadWebConfig(): Promise<WebConfig & { disabledReason?: 'unauthorized' }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const response = await fetch('/app-config.json', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    if (response.status === 401 || response.status === 403) return { backend: null, disabledReason: 'unauthorized' }
    if (!response.ok) return { backend: null }
    const text = await response.text()
    if (text.length > 512) return { backend: null }
    return parseWebConfig(JSON.parse(text))
  } catch { return { backend: null } }
  finally { clearTimeout(timer) }
}
