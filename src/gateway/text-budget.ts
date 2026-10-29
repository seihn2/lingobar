// Share the existing durable batch ledger with the one-shot CLI; no new money store.
// @ts-expect-error The shared operator ledger is an existing CommonJS module.
import ledgerModule from '../../scripts/plan-one-rmb-test.cjs'
import { RelayError, type WorkerFetch } from '../worker/types'

export const TEXT_MAX_RESERVATION_MICRO_CNY = 81_920
export const TEXT_INPUT_TOKEN_CEILING = 8192
export const TEXT_OUTPUT_TOKEN_CEILING = 8192
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
// recipe935817c / V4.1 plaintext encoding: UTF8 symbols only merge, plus the
// JSON-object system suffix105bytes and five explicit control tokens. This is
// the same source-derived bound method, not admission by the fixed-request proof.
const RESPONSE_FORMAT_BYTES = 105
const CONTROL_TOKENS = 5
const object = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key))

export function quoteWebTextRequest(input: RequestInfo | URL, init?: RequestInit): { request: RequestInit; reservationMicroCny: number; fullInputTokenUpperBound: number } {
  const invalid = (): never => { throw new RelayError('protocol') }
  if (String(input) !== ENDPOINT || init?.method !== 'POST' || init.redirect !== 'error' || typeof init.body !== 'string') invalid()
  let body: Record<string, unknown>
  try { body = JSON.parse(init!.body as string) } catch { return invalid() }
  if (!object(body) || !only(body, ['model', 'messages', 'stream', 'max_tokens', 'response_format', 'thinking', 'tool_choice', 'temperature']) ||
    body.model !== 'deepseek-flash' || body.stream !== false || !Number.isInteger(body.max_tokens) ||
    (body.max_tokens as number) < 1 || (body.max_tokens as number) > TEXT_OUTPUT_TOKEN_CEILING ||
    !object(body.thinking) || !only(body.thinking, ['type']) || body.thinking.type !== 'disabled' ||
    !object(body.response_format) || !only(body.response_format, ['type']) || body.response_format.type !== 'json_object' ||
    body.tool_choice !== undefined && body.tool_choice !== 'none' || !Array.isArray(body.messages) || body.messages.length !== 2) invalid()
  const messages = body.messages as unknown[]
  for (const [i, message] of messages.entries()) {
    if (!object(message) || !only(message, ['role', 'content']) || message.role !== (i === 0 ? 'system' : 'user') || typeof message.content !== 'string') invalid()
  }
  const fullInputUpperBound = (messages as { content: string }[]).reduce((n, message) => n + Buffer.byteLength(message.content, 'utf8'), RESPONSE_FORMAT_BYTES + CONTROL_TOKENS)
  if (fullInputUpperBound > TEXT_INPUT_TOKEN_CEILING) invalid()
  return { request: { ...init, body: JSON.stringify({ ...body, tool_choice: 'none' }) },
    fullInputTokenUpperBound: fullInputUpperBound,
    reservationMicroCny: fullInputUpperBound * 2 + (body.max_tokens as number) * 8 }
}
export function webTextRequest(input: RequestInfo | URL, init?: RequestInit): RequestInit { return quoteWebTextRequest(input, init).request }

/** All actual completions, including ruby's format retry, reserve from one batch. */
export class WebTextBudget {
  private readonly ledger: { reservedMicroCny: number; reserveWebText(amount: number): unknown; close(): void }
  constructor(directory: string) { this.ledger = new ledgerModule.OneRmbTestLedger(directory) }
  fetch(upstream: WorkerFetch): WorkerFetch {
    return async (input, init) => {
      if (init?.signal?.aborted) throw new RelayError('unavailable')
      const quote = quoteWebTextRequest(input, init)
      if (this.ledger.reservedMicroCny + quote.reservationMicroCny > 1_000_000) {
        return new Response('{"error":"quota"}', { status: 429 })
      }
      try { this.ledger.reserveWebText(quote.reservationMicroCny) } catch { throw new RelayError('unavailable') }
      if (init?.signal?.aborted) throw new RelayError('unavailable')
      return upstream(ENDPOINT, quote.request)
    }
  }
  close(): void { this.ledger.close() }
}
