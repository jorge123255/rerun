import { env } from '../config/env.js'
import { abortable } from './web-fetch/transport.js'
import { desktopNotifyUserReceiptSchema, type DesktopNotifyUserAdmission, type DesktopNotifyUserReceipt } from './contract'

export class DesktopNotifyUserDeliveryError extends Error {
    constructor(message: string, readonly status: 'unknown') {
        super(message)
        this.name = 'DesktopNotifyUserDeliveryError'
    }
}

export async function deliverDesktopUserNotification(input: DesktopNotifyUserAdmission, signal: AbortSignal): Promise<DesktopNotifyUserReceipt> {
    const config = env(), url = new URL(config.RERUN_HUB_BASE_URL ?? '')
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !config.RERUN_API_KEY) {
        throw new DesktopNotifyUserDeliveryError('Native notification delivery is unavailable.')
    }
    const body = JSON.stringify(input)
    if (Buffer.byteLength(body) > 200_000) throw new DesktopNotifyUserDeliveryError('Notification input exceeds its limit.')
    signal.throwIfAborted()
    try {
        const response = await abortable(fetch(`${url.origin}/api/desktop/engine/notify-user`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.RERUN_API_KEY}`, 'Content-Type': 'application/json' },
            body,
            signal,
            redirect: 'error',
            credentials: 'omit',
        }), signal)
        const reader = response.body?.getReader()
        if (!reader) throw new DesktopNotifyUserDeliveryError('Native notification returned no acknowledgement.')
        const chunks: Uint8Array[] = []
        let size = 0
        const cancel = () => { void reader.cancel().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
            for (;;) {
                signal.throwIfAborted()
                const part = await abortable(reader.read(), signal)
                signal.throwIfAborted()
                if (part.done) break
                size += part.value.byteLength
                if (size > 32_768) throw new DesktopNotifyUserDeliveryError('Native notification acknowledgement exceeds its limit.')
                chunks.push(part.value)
            }
            return desktopNotifyUserReceiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } finally {
            signal.removeEventListener('abort', cancel)
            void reader.cancel().catch(() => {})
        }
    } catch (error) {
        if (error instanceof DesktopNotifyUserDeliveryError) throw error
        throw new DesktopNotifyUserDeliveryError(error instanceof Error ? error.message : 'Native notification acknowledgement is unknown.')
    }
}
