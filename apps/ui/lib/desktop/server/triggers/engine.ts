import 'server-only'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'

/** Private, authenticated, same-launch engine management. Never use hosted trigger mutation routes. */
export async function desktopTriggerEngine(runtime: DesktopRuntime, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${runtime.engine.origin}/desktop/triggers/manage`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ launchNonce: runtime.launchNonce, ...payload as object }), signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) })
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0
    if (!reader) throw new DesktopHttpError(502, 'Trigger response is unavailable')
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1048576) throw new DesktopHttpError(502, 'Trigger response is too large'); chunks.push(part.value) } }
    finally { void reader.cancel().catch(() => {}) }
    const text = Buffer.concat(chunks).toString('utf8')
    let value: { error?: string; result?: unknown }
    try { value = JSON.parse(text) } catch { throw new DesktopHttpError(502, 'Invalid trigger response') }
    if (!response.ok) throw new DesktopHttpError(response.status >= 400 && response.status < 600 ? response.status : 502, typeof value.error === 'string' && value.error.length < 500 ? value.error : 'Trigger request failed')
    return value.result
}
