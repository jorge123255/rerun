import { timingSafeEqual } from 'node:crypto'
import { DESKTOP_TRIGGER_MAX_INGRESS_BODY_BYTES, triggerFireSchema } from '@rerun/contracts'
import { webhookAdmissionSchema, type WebhookAdmission } from './contract.js'

export type WebhookDeliveryState = 'accepted' | 'running' | 'needs-input' | 'done' | 'cancelled' | 'error' | 'uncertain'

export type WebhookDedupPort = {
    find(key: { workspaceId: number; targetId: string; eventKey: string }, signal: AbortSignal): Promise<
        | { state: 'absent' }
        | { state: 'known'; eventId: string; status: WebhookDeliveryState }
        | { state: 'unknown' }
    >
}

export type WebhookSecretPort = {
    read(target: { workspaceId: number; targetId: string }, signal: AbortSignal): Promise<string | null>
}

const closed = (outcome: WebhookAdmission['outcome'], replay = false): WebhookAdmission =>
    webhookAdmissionSchema.parse({ outcome, scheduled: false, grantsTools: false, replay })

function tokenMatches(given: string, expected: string): boolean {
    const left = Buffer.from(given, 'utf8')
    const right = Buffer.from(expected, 'utf8')
    return left.length === right.length && timingSafeEqual(left, right)
}

export function createIncomingWebhookAdmission(ports: { secrets: WebhookSecretPort; deliveries: WebhookDedupPort }) {
    return {
        async admit(input: {
            enabled: boolean
            scheme: 'token' | 'unsupported'
            workspaceId: number
            targetId: string
            eventKey: string
            fire: unknown
            signal: AbortSignal
        }): Promise<WebhookAdmission> {
            if (input.enabled !== true) return closed('disabled')
            if (input.signal.aborted) return closed('cancelled')
            if (input.scheme !== 'token') return closed('unavailable')
            const fire = triggerFireSchema.safeParse(input.fire)
            if (!fire.success || fire.data.bodyBytes > DESKTOP_TRIGGER_MAX_INGRESS_BODY_BYTES || Buffer.byteLength(fire.data.body, 'utf8') > DESKTOP_TRIGGER_MAX_INGRESS_BODY_BYTES) {
                return closed('refused')
            }
            let secret: string | null
            try {
                secret = await ports.secrets.read({ workspaceId: input.workspaceId, targetId: input.targetId }, input.signal)
            } catch {
                return closed('uncertain')
            }
            if (input.signal.aborted) return closed('cancelled')
            if (!secret || !tokenMatches(fire.data.token, secret)) return secret ? closed('refused') : closed('unavailable')
            let prior: Awaited<ReturnType<WebhookDedupPort['find']>>
            try {
                prior = await ports.deliveries.find({ workspaceId: input.workspaceId, targetId: input.targetId, eventKey: input.eventKey }, input.signal)
            } catch {
                return closed('uncertain')
            }
            if (input.signal.aborted) return closed('uncertain')
            if (prior.state === 'unknown' || (prior.state === 'known' && prior.status === 'uncertain')) return closed('uncertain')
            if (prior.state === 'known') return webhookAdmissionSchema.parse({ outcome: 'duplicate', scheduled: false, grantsTools: false, replay: true, eventId: prior.eventId })
            return closed('authorized')
        },
    }
}
