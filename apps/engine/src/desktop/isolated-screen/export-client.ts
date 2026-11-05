import { env } from '../../config/env.js'
import { z } from 'zod'
import { abortable } from '../web-fetch/transport.js'
import { isolatedScreenOwner } from './binding.js'
import { screenExportIdentity, validateScreenExportManifest, validateScreenExportResult, type ScreenExportPublisher, type ScreenExportIdentity } from './transport.js'
import type { ScreenSavedExports } from './types.js'

async function post(body: string, signal: AbortSignal, limit = 32_768): Promise<unknown> {
    const config = env(), url = new URL(config.RERUN_HUB_BASE_URL ?? '')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !config.RERUN_API_KEY) throw new Error('Browser file publication is unavailable.')
    if (Buffer.byteLength(body) > 11 * 1024 * 1024) throw new Error('Browser export body exceeds limit.')
    const response = await abortable(fetch(`${url.origin}/api/desktop/engine/browser-exports`, { method: 'POST', headers: { Authorization: `Bearer ${config.RERUN_API_KEY}`, 'Content-Type': 'application/json' }, body, signal, redirect: 'error', credentials: 'omit' }), signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Browser export acknowledgement unavailable.')
    const chunks: Uint8Array[] = []; let size = 0
    try {
        for (;;) {
            const next = await abortable(reader.read(), signal)
            if (next.done) break
            size += next.value.length
            if (size > limit) throw new Error('Browser export acknowledgement exceeds limit.')
            chunks.push(next.value)
        }
        if (!response.ok) throw new Error('Browser export could not be acknowledged.')
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } finally { await reader.cancel().catch(() => {}) }
}

function call(operation: 'publish' | 'read', identity: ScreenExportIdentity, artifacts: unknown[] | undefined, signal: AbortSignal): Promise<ScreenSavedExports> {
    const body = JSON.stringify({ operation, launchNonce: isolatedScreenOwner(identity.engineAgentId).launchNonce, call: screenExportIdentity(identity), ...(artifacts && { artifacts }) })
    return post(body, signal) as Promise<ScreenSavedExports>
}

export const desktopBrowserExportPublisher: ScreenExportPublisher = async (input, signal) => {
    const files = input.artifacts.map(item => ({ kind: item.kind, path: item.path, sha256: item.sha256, byteLength: item.bytes.length }))
    const result = await call('publish', input, input.artifacts.map(item => ({ ...item, bytes: item.bytes.toString('base64') })), signal)
    return validateScreenExportResult(result, files)
}

/** Read-only recovery: never navigates, captures, publishes, or recreates a missing file. */
export async function readDesktopBrowserExports(identity: ScreenExportIdentity, signal: AbortSignal): Promise<ScreenSavedExports> {
    const result = await call('read', identity, undefined, signal)
    if (!Array.isArray(result?.files) || result.status === 'saved' && !result.files.length) throw new Error('Invalid browser export recovery.')
    const files = result.files.length ? validateScreenExportManifest(result.files) : []
    return validateScreenExportResult(result, files)
}

/** Only exact receipt-owned cache text is readable; ordinary hidden-file policy stays closed. */
export async function readDesktopBrowserExportCache(identity: { engineAgentId: string; sessionId: string; runId: string }, path: string, signal: AbortSignal) {
    const body = JSON.stringify({ operation: 'read-file', launchNonce: isolatedScreenOwner(identity.engineAgentId).launchNonce, call: identity, path })
    const result = z.strictObject({ path: z.string(), content: z.string(), size: z.number().int().nonnegative().max(1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await post(body, signal, 7 * 1024 * 1024))
    if (result.path !== path || Buffer.byteLength(result.content) !== result.size) throw new Error('Saved browser file changed.')
    return result
}
