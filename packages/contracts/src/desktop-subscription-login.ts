import { z } from 'zod'

export const desktopSubscriptionProvider = z.enum(['grok-build', 'kimi-code'])
export type DesktopSubscriptionProvider = z.infer<typeof desktopSubscriptionProvider>

export function isDesktopSubscriptionProvider(provider: unknown): provider is DesktopSubscriptionProvider {
    return provider === 'grok-build' || provider === 'kimi-code'
}

const subscriptionConnectionId = /^mac-(grok-build|kimi-code)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
export function parseDesktopSubscriptionConnectionId(id: string | null | undefined) {
    const match = id?.match(subscriptionConnectionId)
    if (!match || !isDesktopSubscriptionProvider(match[1])) return null
    return { provider: match[1], generation: match[2]! }
}

const catalogId = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value))
export const desktopSubscriptionModels = z.array(z.object({
    id: catalogId,
    label: z.string().trim().min(1).max(256),
    reasoning: z.object({
        supported: z.array(catalogId).min(1).max(128),
        default: catalogId,
    }).refine(({ supported, default: effort }) => supported.includes(effort)).optional(),
})).min(1).max(128).refine(models => new Set(models.map(model => model.id)).size === models.length)

export const desktopSubscriptionDeviceCode = z.string().regex(/^[A-Z0-9]{3,12}(?:-[A-Z0-9]{3,12}){0,2}$/)
const verificationHosts = {
    'grok-build': new Set(['auth.x.ai', 'x.ai', 'grok.com', 'www.grok.com', 'accounts.x.ai']),
    'kimi-code': new Set(['auth.kimi.ai', 'kimi.ai', 'www.kimi.ai', 'auth.kimi.com', 'kimi.com', 'www.kimi.com']),
}

export function desktopSubscriptionVerificationUrl(provider: DesktopSubscriptionProvider, value: string) {
    if (value.length > 600) return null
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.port || url.username || url.password ||
            !verificationHosts[provider].has(url.hostname)) return null
        // Device code is displayed separately. No other runner query or fragment reaches the renderer.
        // Kimi's page reads the code from the address and answers "Missing user_code parameter"
        // without it, so that one parameter stays, checked like the code shown beside the link.
        const code = provider === 'kimi-code' ? url.searchParams.get('user_code') : null
        const kept = code && desktopSubscriptionDeviceCode.safeParse(code).success ? `?user_code=${code}` : ''
        return url.origin + url.pathname + kept
    } catch {
        return null
    }
}

const status = z.discriminatedUnion('phase', [
    z.object({ phase: z.literal('unavailable') }),
    z.object({ phase: z.literal('idle') }),
    z.object({ phase: z.literal('starting') }),
    z.object({ phase: z.literal('cancelling') }),
    z.object({
        phase: z.literal('waiting'),
        verificationUrl: z.string().max(600),
        userCode: desktopSubscriptionDeviceCode,
    }),
    z.object({
        phase: z.literal('approved'),
        canRefreshModels: z.boolean().optional(),
        chatReady: z.boolean().optional(),
        models: desktopSubscriptionModels.optional(),
    }),
    z.object({ phase: z.literal('error'), reason: z.enum(['failed', 'expired', 'unconfirmed']) }),
])

function providerStatus(provider: DesktopSubscriptionProvider) {
    return status.refine(value => value.phase !== 'waiting' ||
        desktopSubscriptionVerificationUrl(provider, value.verificationUrl) === value.verificationUrl)
}

export const desktopSubscriptionLoginSnapshot = z.object({
    'grok-build': providerStatus('grok-build'),
    'kimi-code': providerStatus('kimi-code'),
})
export const desktopSubscriptionLoginAction = z.object({
    provider: desktopSubscriptionProvider,
    action: z.enum(['start', 'cancel', 'disconnect', 'refresh-models']),
}).strict()
export type DesktopSubscriptionLoginSnapshot = z.infer<typeof desktopSubscriptionLoginSnapshot>
export type DesktopSubscriptionLoginStatus = z.infer<typeof status>
export type DesktopSubscriptionLoginAction = z.infer<typeof desktopSubscriptionLoginAction>
