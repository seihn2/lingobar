import { gatewayConfig } from './config'
import { createGateway } from './server'

try {
  const port = Number(process.env.GATEWAY_PORT || '8788')
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error()
  const gateway = createGateway(gatewayConfig(process.env))
  const shutdown = () => { void gateway.close().catch(() => { console.error('LingoBar gateway could not finish shutdown'); process.exitCode = 1 }) }
  gateway.server.on('error', () => { console.error('LingoBar gateway could not listen'); process.exitCode = 1; shutdown() })
  gateway.server.listen(port, '127.0.0.1', () => console.log('LingoBar gateway listening on loopback; no provider self-test performed'))
  let stopping = false
  const stop = () => { if (!stopping) { stopping = true; shutdown() } }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
} catch { console.error('LingoBar gateway configuration or private budget state unavailable'); process.exitCode = 1 }
