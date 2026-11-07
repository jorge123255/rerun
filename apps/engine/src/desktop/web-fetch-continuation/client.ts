import { env } from '../../config/env.js'
import { abortable } from '../web-fetch/transport.js'
import { isolatedScreenOwner } from '../isolated-screen/binding.js'
import { screenExportIdentity, validateScreenExportResult, type ScreenExportCall, type ScreenExportPublisher } from '../isolated-screen/transport.js'
import type { ScreenSavedExports } from '../isolated-screen/types.js'
import type { WebFetchContinuationPublisher } from './continuation.js'

async function post(call: ScreenExportCall, signal: AbortSignal): Promise<ScreenSavedExports> {
    const config = env(), url = new URL(config.RERUN_HUB_BASE_URL ?? '')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !config.RERUN_API_KEY) throw new Error('Web page publication is unavailable.')
    const body = JSON.stringify({
        operation: 'publish-web-fetch',
        launchNonce: isolatedScreenOwner(call.engineAgentId).launchNonce,
        call: screenExportIdentity(call),
        artifacts: call.artifacts.map(item => ({ ...item, bytes: Buffer.isBuffer(item.bytes) ? item.bytes.toString('base64') : item.bytes })),
    })
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Web page publication body exceeds limit.')
    const response = await abortable(fetch(`${url.origin}/api/desktop/engine/browser-exports`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.RERUN_API_KEY}`, 'Content-Type': 'application/json' }, body, signal, redirect: 'error', credentials: 'omit',
    }), signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Web page publication acknowledgement unavailable.')
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        for (;;) {
            const part = await abortable(reader.read(), signal)
            if (part.done) break
            size += part.value.length
            if (size > 32_768) throw new Error('Web page publication acknowledgement exceeds limit.')
            chunks.push(part.value)
        }
        if (!response.ok) throw new Error('Web page publication could not be acknowledged.')
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ScreenSavedExports
    } finally { await reader.cancel().catch(() => {}) }
}

export const desktopWebFetchContinuationPublisher: WebFetchContinuationPublisher = async (call, signal) => {
    const files = call.artifacts.map(item => ({ kind: item.kind, path: item.path, sha256: item.sha256, byteLength: item.bytes.length }))
    const result = await post({ ...call, artifacts: call.artifacts.map(item => ({ ...item, bytes: item.bytes.toString('base64') as unknown as Buffer })) }, signal)
    return validateScreenExportResult(result, files)
}
