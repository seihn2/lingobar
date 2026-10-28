import { createServer } from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodePeer, nodeTransport } from '../src/gateway/transport'

const dispose: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const fn of dispose.splice(0).reverse()) await fn() })
const upstream = 'https://dashscope.aliyuncs.com/api-ws/v1/inference'
const init = (signal?: AbortSignal) => ({ headers: { Upgrade: 'websocket', Authorization: 'Bearer synthetic-asr' }, redirect: 'error' as const, signal })
async function endpoint(status: number) {
  const server = createServer((_req, res) => { res.writeHead(status, { Location: 'https://attacker.example' }); res.end('synthetic raw provider response') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  dispose.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`
  const connect = vi.fn((_url: string, options: WebSocket.ClientOptions) => new WebSocket(url, options))
  return { connect }
}
describe('Node ws boundary, no live providers', () => {
  it.each([301, 401, 403, 429, 503])('maps real handshake HTTP%s without following redirects or reading raw bodies', async status => {
    const { connect } = await endpoint(status), http = vi.fn<typeof fetch>()
    const response = await nodeTransport(http, connect)(upstream, init())
    expect(response.status).toBe(status); expect(response.webSocket).toBeNull(); expect(http).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledOnce(); expect(connect.mock.calls[0][1]).toMatchObject({ followRedirects: false, perMessageDeflate: false, maxPayload: 131072 })
  })
  it.each([
    ['https://attacker.example', init()], ['http://dashscope.aliyuncs.com/api-ws/v1/inference', init()],
    [upstream, { ...init(), redirect: 'follow' }], [upstream, { ...init(), headers: { ...init().headers, Cookie: 'synthetic-cookie' } }],
    ['https://api.deepseek.com/chat/completions?url=elsewhere', { method: 'POST', ...init() }]
  ])('refuses unsafe transport before opening any socket %#', async (url, options) => {
    const http = vi.fn<typeof fetch>(), connect = vi.fn((_url: string, _options: WebSocket.ClientOptions) => { throw new Error('must not connect') })
    await expect(nodeTransport(http, connect)(String(url), options as RequestInit)).rejects.toMatchObject({ code: 'protocol' })
    expect(http).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled()
  })
  it('cancels an unacknowledged native handshake without reconnecting or leaking rejection details', async () => {
    const server = createServer(), peers = new Set<import('node:net').Socket>()
    server.on('connection', peer => { peers.add(peer); peer.once('close', () => peers.delete(peer)) })
    server.on('upgrade', () => { /* synthetic provider deliberately never completes handshake */ })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    dispose.push(() => new Promise<void>(resolve => { for (const peer of peers) peer.destroy(); server.close(() => resolve()) }))
    const connect = vi.fn((_url: string, options: WebSocket.ClientOptions) => new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`, options))
    const controller = new AbortController(), pending = nodeTransport(vi.fn(), connect)(upstream, init(controller.signal))
    controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'unavailable' }); expect(connect).toHaveBeenCalledOnce()
  })
  it('isolates an exception in a message gate from the Node process', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>(resolve => server.once('listening', resolve))
    dispose.push(() => new Promise<void>(resolve => { for (const peer of server.clients) peer.terminate(); server.close(() => resolve()) }))
    let remote!: WebSocket
    server.once('connection', ws => { remote = ws })
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`)
    await new Promise<void>(resolve => socket.once('open', resolve))
    const gate = vi.fn(() => { throw new Error('synthetic gate failure') }), peer = new NodePeer(socket, gate)
    peer.accept(); remote.send('synthetic frame')
    await vi.waitFor(() => expect(gate).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED))
    expect(() => peer.send('closed')).toThrow('upstream')
  })
  it('refuses an oversized queued send before handing it to the native socket', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>(resolve => server.once('listening', resolve))
    dispose.push(() => new Promise<void>(resolve => { for (const peer of server.clients) peer.terminate(); server.close(() => resolve()) }))
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}`)
    await new Promise<void>(resolve => socket.once('open', resolve))
    const peer = new NodePeer(socket), send = vi.spyOn(socket, 'send')
    expect(() => peer.send(new Uint8Array(256 * 1024 + 1))).toThrow('upstream'); expect(send).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED))
  })
})
