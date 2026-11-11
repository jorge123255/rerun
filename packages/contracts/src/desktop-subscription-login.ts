import { z } from 'zod'

export const desktopSubscriptionProvider = z.enum(['grok-build', 'kimi-code'])
export type DesktopSubscriptionProvider = z.infer<typeof desktopSubscriptionProvider>

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
        // Device code is displayed separately. No runner query or fragment reaches the renderer.
        return url.origin + url.pathname
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
    z.object({ phase: z.literal('approved') }),
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
    action: z.enum(['start', 'cancel', 'disconnect']),
}).strict()
export type DesktopSubscriptionLoginSnapshot = z.infer<typeof desktopSubscriptionLoginSnapshot>
export type DesktopSubscriptionLoginStatus = z.infer<typeof status>
export type DesktopSubscriptionLoginAction = z.infer<typeof desktopSubscriptionLoginAction>
