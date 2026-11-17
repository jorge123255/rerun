import { z } from 'zod'

/** What Settings shows about talking to the Chief of Staff from the phone. Never a secret or a key. */
export const desktopVoiceEngineStatusSchema = z.strictObject({
    relayOrigin: z.string().nullable(),
    enabled: z.boolean(),
    keySaved: z.boolean(),
    engineReady: z.boolean(),
    /** The engine was made with another ElevenLabs key or another relay address: make it again. */
    engineStale: z.boolean(),
    relayConnected: z.boolean(),
})
export type DesktopVoiceEngineStatus = z.infer<typeof desktopVoiceEngineStatusSchema>

/** Shown once, when the relay's credentials are made: what the owner gives their Worker. */
export const desktopVoiceRelayDeploySchema = z.strictObject({
    installId: z.string(),
    relaySecret: z.string(),
    /** The whole value of the Worker's RELAY_INSTALLS secret for this Mac. */
    workerSecret: z.string(),
})
export type DesktopVoiceRelayDeploy = z.infer<typeof desktopVoiceRelayDeploySchema>

export const desktopVoiceEngineReplySchema = z.strictObject({
    status: desktopVoiceEngineStatusSchema,
    deploy: desktopVoiceRelayDeploySchema.optional(),
})

export const desktopVoiceEngineActionSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('relay'), relayOrigin: z.string().trim().min(1).max(300) }),
    z.strictObject({ action: z.literal('rotate') }),
    z.strictObject({ action: z.literal('create-engine') }),
    z.strictObject({ action: z.literal('enabled'), enabled: z.boolean() }),
    z.strictObject({ action: z.literal('forget') }),
])
export type DesktopVoiceEngineAction = z.infer<typeof desktopVoiceEngineActionSchema>

/** A relay address is the https origin of the owner's Worker: no path, query, port or credentials. */
export function desktopVoiceRelayOrigin(value: string): string | null {
    let url: URL
    try { url = new URL(value.trim().includes('://') ? value.trim() : `https://${value.trim()}`) } catch { return null }
    if (url.protocol === 'wss:') url = new URL(url.toString().replace(/^wss:/, 'https:'))
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return null
    const host = url.hostname.toLowerCase()
    // A public name only: the relay is reached by ElevenLabs over the internet.
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || host.endsWith('.local') || host.endsWith('.localhost')) return null
    return `https://${host}`
}
