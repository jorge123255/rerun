import 'server-only'
import { DesktopHttpError } from './auth'

export async function readNotificationBody(request: Request): Promise<unknown> {
    if (!request.body) throw new DesktopHttpError(400, 'Send a notification request.')
    const reader = request.body.getReader(), chunks: Uint8Array[] = []
    let size = 0, timer: ReturnType<typeof setTimeout> | undefined
    try {
        const bytes = await Promise.race([
            (async () => {
                for (;;) {
                    const part = await reader.read()
                    if (part.done) break
                    size += part.value.byteLength
                    if (size > 40_000) throw new DesktopHttpError(413, 'Notification request is too large.')
                    chunks.push(part.value)
                }
                return Buffer.concat(chunks)
            })(),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DesktopHttpError(408, 'Notification request timed out.')), 5000) }),
        ])
        try { return JSON.parse(bytes.toString('utf8')) } catch { throw new DesktopHttpError(400, 'Send a valid notification request.') }
    } finally {
        clearTimeout(timer)
        void reader.cancel().catch(() => {})
    }
}
