import { z } from 'zod'

export const desktopSubscriptionProvider = z.enum(['grok-build', 'kimi-code', 'devin'])
export type DesktopSubscriptionProvider = z.infer<typeof desktopSubscriptionProvider>

export function isDesktopSubscriptionProvider(provider: unknown): provider is DesktopSubscriptionProvider {
    return provider === 'grok-build' || provider === 'kimi-code' || provider === 'devin'
}

const subscriptionConnectionId = /^mac-(grok-build|kimi-code|devin)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
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
    devin: new Set(['app.devin.ai', 'windsurf.com', 'www.windsurf.com']),
}

export function desktopSubscriptionVerificationUrl(provider: DesktopSubscriptionProvider, value: string) {
    if (value.length > (provider === 'devin' ? 1200 : 600)) return null
    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' || url.port || url.username || url.password ||
            !verificationHosts[provider].has(url.hostname)) return null
        // Device code is displayed separately. No other runner query or fragment reaches the renderer.
        // Kimi's page reads the code from the address and answers "Missing user_code parameter"
        // without it, so that one parameter stays, checked like the code shown beside the link.
        // Devin's sign-in page is the whole address: its query carries the public half of a one-time
        // exchange (state and code challenge), never a credential. The page then shows a code to paste back.
        if (provider === 'devin') return url.origin + url.pathname + url.search
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
    // Devin signs in on its page and hands back a code to paste into the app.
    z.object({ phase: z.literal('code'), verificationUrl: z.string().max(1200) }),
    z.object({
        phase: z.literal('approved'),
        canRefreshModels: z.boolean().optional(),
        chatReady: z.boolean().optional(),
        models: desktopSubscriptionModels.optional(),
    }),
    z.object({ phase: z.literal('error'), reason: z.enum(['failed', 'expired', 'unconfirmed']) }),
])

function providerStatus(provider: DesktopSubscriptionProvider) {
    return status.refine(value => (value.phase !== 'waiting' && value.phase !== 'code') ||
        desktopSubscriptionVerificationUrl(provider, value.verificationUrl) === value.verificationUrl)
}

export const desktopSubscriptionLoginSnapshot = z.object({
    'grok-build': providerStatus('grok-build'),
    'kimi-code': providerStatus('kimi-code'),
    devin: providerStatus('devin'),
})
export const desktopSubscriptionLoginAction = z.object({
    provider: desktopSubscriptionProvider,
    action: z.enum(['start', 'cancel', 'disconnect', 'refresh-models', 'submit-code']),
    // The code Devin's page shows after sign-in. Only read with `submit-code`.
    code: z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/).optional(),
}).strict().refine(value => (value.action === 'submit-code') === (value.code !== undefined))
export type DesktopSubscriptionLoginSnapshot = z.infer<typeof desktopSubscriptionLoginSnapshot>
export type DesktopSubscriptionLoginStatus = z.infer<typeof status>
export type DesktopSubscriptionLoginAction = z.infer<typeof desktopSubscriptionLoginAction>
