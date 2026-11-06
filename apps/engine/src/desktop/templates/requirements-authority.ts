import { z } from 'zod'
import { desktopTemplateRequirementsSchema } from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'

const responseSchema = z.strictObject({ engineAgentId: z.string(), requirements: desktopTemplateRequirementsSchema })
export async function readTrustedTemplateRequirements(engineAgentId: string) {
    const origin = new URL(process.env.RERUN_HUB_BASE_URL ?? '')
    const token = process.env.RERUN_API_KEY
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(engineAgentId) || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash || !token) throw new TemplateRequestError(503, 'Template requirement authority is unavailable')
    const signal = AbortSignal.timeout(10_000)
    const response = await fetch(`${origin.origin}/api/desktop/internal/template-requirements`, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ engineAgentId }),
    })
    if (!response.ok || !response.body) throw new TemplateRequestError(503, 'Template requirement authority is unavailable')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0
    const cancel = () => { void reader.cancel().catch(() => {}) }; signal.addEventListener('abort', cancel, { once: true })
    try {
        for (;;) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new TemplateRequestError(413, 'Template requirements are too large'); chunks.push(part.value) }
        const parsed = responseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (parsed.engineAgentId !== engineAgentId) throw new TemplateRequestError(409, 'Template requirement owner changed')
        return parsed.requirements
    } finally { signal.removeEventListener('abort', cancel); void reader.cancel().catch(() => {}) }
}
