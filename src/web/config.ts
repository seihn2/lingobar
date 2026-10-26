/** Public routing metadata only. Provider credentials never belong in this file. */
export function parseWebConfig(value: unknown): { backend: '/api/session' | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('网页配置格式不正确。')
  const input = value as Record<string, unknown>
  if (input.version !== 1 || Object.keys(input).some(key => !['version', 'backend'].includes(key)) || (input.backend !== null && input.backend !== '/api/session')) throw new Error('网页配置格式不正确。')
  return { backend: input.backend }
}
export async function loadWebConfig(): Promise<{ backend: '/api/session' | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const response = await fetch('/app-config.json', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
    if (!response.ok) return { backend: null }
    const text = await response.text()
    if (text.length > 512) return { backend: null }
    return parseWebConfig(JSON.parse(text))
  } catch { return { backend: null } }
  finally { clearTimeout(timer) }
}
