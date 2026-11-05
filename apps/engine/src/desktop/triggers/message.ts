import { DESKTOP_TRIGGER_MAX_MODEL_PAYLOAD_BYTES, type DesktopTriggerFireInput } from '@rerun/contracts'

export const MAX_PAYLOAD_BYTES = DESKTOP_TRIGGER_MAX_MODEL_PAYLOAD_BYTES

type TriggerLike = { slug: string; body: string }

function attr(value: string): string {
    return value.replace(/"/g, '&quot;').slice(0, 200)
}

function pretty(body: string, contentType: string): string {
    if (!contentType.includes('json')) return body
    try {
        return JSON.stringify(JSON.parse(body), null, 2)
    } catch {
        return body
    }
}

function truncate(text: string, totalBytes: number): { text: string; truncated: boolean } {
    if (Buffer.byteLength(text, 'utf8') <= MAX_PAYLOAD_BYTES) return { text, truncated: false }
    const cut = Buffer.from(text, 'utf8').subarray(0, MAX_PAYLOAD_BYTES).toString('utf8')
    return { text: `${cut}\n… [truncated, ${totalBytes} bytes total]`, truncated: true }
}

/** Original apps/engine/src/triggers/message.ts — never include Authorization/Cookie/token. */
export function buildDesktopTriggerMessage(trigger: TriggerLike, fire: DesktopTriggerFireInput, receivedAt: string): { message: string; truncated: boolean } {
    const attrs = [
        `trigger="${attr(trigger.slug)}"`,
        `method="${attr(fire.method)}"`,
        `received="${attr(receivedAt)}"`,
    ]
    if (fire.query) attrs.push(`query="${attr(fire.query)}"`)
    if (fire.contentType) attrs.push(`content-type="${attr(fire.contentType)}"`)
    attrs.push(`bytes="${fire.bodyBytes}"`)

    const raw = fire.body.trim()
    if (!raw) {
        return {
            message: `${trigger.body.trim()}\n\n<trigger_payload ${attrs.join(' ')}>(no payload)</trigger_payload>`,
            truncated: false,
        }
    }

    const escaped = pretty(raw, fire.contentType).replaceAll('</trigger_payload>', '<\\/trigger_payload>')
    const { text, truncated } = truncate(escaped, fire.bodyBytes)
    if (truncated) attrs.push('truncated="true"')
    return {
        message: `${trigger.body.trim()}\n\n<trigger_payload ${attrs.join(' ')}>\n${text}\n</trigger_payload>`,
        truncated,
    }
}

/** Strip secrets from any diagnostic string before logs/notifications/errors. */
export function redactTriggerSecrets(text: string, secrets: string[]): string {
    let out = text
    for (const secret of secrets) {
        if (!secret) continue
        out = out.split(secret).join('[redacted]')
    }
    out = out.replace(/Authorization:\s*\S+/gi, 'Authorization: [redacted]')
    out = out.replace(/Cookie:\s*[^\n]+/gi, 'Cookie: [redacted]')
    return out
}
