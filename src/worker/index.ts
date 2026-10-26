import { authorized, serverConfig, type WorkerEnv } from './config'
import { RelaySession } from './session'
import type { WorkerSocket, WorkerFetch } from './types'

declare const WebSocketPair: { new(): { 0: WorkerSocket; 1: WorkerSocket } }
export interface WorkerContext { waitUntil(promise: Promise<unknown>): void }
interface Dependencies {
  fetch: WorkerFetch
  pair(): [WorkerSocket, WorkerSocket]
  upgrade(client: WorkerSocket): Response
  id(): string
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })

/** Fetch/upgrade boundaries are injectable for synthetic tests; defaults use Workers Web APIs only. */
export function createWorker(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    fetch: (input, init) => fetch(input, init),
    pair: () => { const pair = new WebSocketPair(); return [pair[0], pair[1]] },
    upgrade: client => new Response(null, { status: 101, webSocket: client } as ResponseInit),
    id: () => crypto.randomUUID(), ...overrides
  }
  return {
    async fetch(request: Request, env: WorkerEnv, context: WorkerContext): Promise<Response> {
      const url = new URL(request.url)
      if (!['/api/session', '/app-config.json'].includes(url.pathname)) {
        if (url.pathname.startsWith('/api/')) return json({ error: 'protocol' }, 404)
        if (!env.ASSETS || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 })
        // Static asset binding is internal. Do not forward identity headers to it.
        return env.ASSETS.fetch(new Request(url.toString(), { method: request.method }))
      }
      if (request.method !== 'GET') return json({ error: 'protocol' }, 405)
      if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) return json({ error: 'protocol' }, 400)
      const origin = request.headers.get('Origin')
      if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site' || (url.pathname === '/api/session' && !origin)) return json({ error: 'unauthorized' }, 403)
      const config = serverConfig(env)
      if (!config) return url.pathname === '/app-config.json' ? json({ version: 1, backend: null }) : json({ error: 'unavailable' }, 503)
      if (!await authorized(request, env.AUTH_SERVICE!)) return json({ error: 'unauthorized' }, 401)
      if (request.signal.aborted) return json({ error: 'unavailable' }, 499)
      if (url.pathname === '/app-config.json') return json({ version: 1, backend: '/api/session' })
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'protocol' }, 426)
      const [client, server] = deps.pair()
      const session = new RelaySession(server, config, { fetch: deps.fetch, id: deps.id, hold: promise => context.waitUntil(promise) })
      try {
        server.binaryType = 'arraybuffer'
        server.accept()
        return deps.upgrade(client)
      } catch { session.stop(); return json({ error: 'unavailable' }, 503) }
    }
  }
}

export default createWorker()
