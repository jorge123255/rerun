import { DESKTOP_TRIGGER_MAX_INGRESS_BODY_BYTES } from '@rerun/contracts'

export const MAX_TRIGGER_BODY_BYTES = DESKTOP_TRIGGER_MAX_INGRESS_BODY_BYTES

/** Original apps/ui/lib/triggers/webhook.ts readBodyCapped — count the stream, drop past the cap. */
export async function readBodyCapped(req: Request, maxBytes: number = MAX_TRIGGER_BODY_BYTES): Promise<string | null> {
    if (Number(req.headers.get('content-length') ?? 0) > maxBytes) return null
    if (!req.body) return ''
    const reader = req.body.getReader()
    const decoder = new TextDecoder()
    let total = 0
    let text = ''
    try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            total += chunk.value.byteLength
            if (total > maxBytes) break
            text += decoder.decode(chunk.value, { stream: true })
        }
    } catch {
        return ''
    }
    if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
    }
    return text + decoder.decode()
}
