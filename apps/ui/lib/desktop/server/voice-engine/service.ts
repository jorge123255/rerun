import 'server-only'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { desktopVoiceRelayOrigin, type DesktopVoiceEngineStatus, type DesktopVoiceRelayDeploy } from '../../voice-engine'
import { DesktopHttpError } from '../auth'
import type { VoiceChief } from './conversation'
import type { VoiceEngineApi } from './elevenlabs'
import { verifySpeechEngineToken } from './jwt'
import { createRelayClient, type RelayClient, type RelaySocketFactory } from './relay-client'
import { relayMacUrl, relaySpeechEngineUrl } from './relay-protocol'
import { createMintedConversations, createUpstreamSession, MINTED_TTL_MS } from './session'
import type { DesktopVoiceEngineStore, VoiceEngineSettings } from './store'

const SESSION_LIMIT = 4

export type VoiceEngineDeps = {
    store: Pick<DesktopVoiceEngineStore, 'read' | 'secret' | 'saveRelay' | 'rotate' | 'setEngine' | 'setEnabled' | 'forget'>
    /** Whether an ElevenLabs key is saved, and its revision. Never the key. */
    keyInfo(): Promise<{ configured: boolean; revision: string }>
    /** The saved ElevenLabs key, read where it is used and nowhere else. */
    readKey(): Promise<{ revision: string; key: string } | null>
    voiceId(): Promise<string>
    api: VoiceEngineApi
    chief: VoiceChief & { assertChat(chat: DesktopForemanChatRef): Promise<void> }
    socket?: RelaySocketFactory
    now?: () => number
    fillerMs?: number
}

export type VoiceConversationGrant = { conversationToken: string; conversationId: string; expiresAt: string }

const unavailable = () => new DesktopHttpError(503, 'Voice conversations are not available right now.', 'voice_unavailable')
const off = () => new DesktopHttpError(404, 'Not found')

/**
 * The Mac's side of a voice conversation with the Chief of Staff. While the owner has it on, it
 * keeps one outbound connection to their relay; each connection ElevenLabs makes through the relay
 * is checked against the saved key and answered by Chief of Staff turns.
 */
export function createVoiceEngineService(deps: VoiceEngineDeps) {
    const now = deps.now ?? Date.now
    const minted = createMintedConversations(now)
    const sessions = new Map<string, ReturnType<typeof createUpstreamSession>>()
    let relay: RelayClient | null = null, relayIdentity: string | null = null
    let closed = false

    async function verify(authorization: string) {
        const saved = await deps.readKey().catch(() => null)
        return !!saved && verifySpeechEngineToken(authorization, saved.key, Math.floor(now() / 1000)) === 'ok'
    }

    function endSessions() {
        for (const session of sessions.values()) session.closed()
        sessions.clear()
    }

    function openRelay(settings: VoiceEngineSettings & { relayOrigin: string; installId: string }) {
        const client: RelayClient = createRelayClient({
            url: relayMacUrl(settings.relayOrigin, settings.installId),
            installId: settings.installId,
            secret: () => deps.store.secret(),
            socket: deps.socket,
            now,
            handlers: {
                open(channel, authorization) {
                    if (relay !== client || sessions.size >= SESSION_LIMIT || sessions.has(channel)) return client.close(channel)
                    sessions.set(channel, createUpstreamSession({
                        authorization, verify, minted, chief: deps.chief, fillerMs: deps.fillerMs,
                        send: message => { client.send(channel, message) },
                        close: () => { sessions.delete(channel); client.close(channel) },
                    }))
                },
                frame(channel, message) {
                    const session = sessions.get(channel)
                    if (session) void session.frame(message)
                    else client.close(channel)
                },
                closed(channel) {
                    sessions.get(channel)?.closed()
                    sessions.delete(channel)
                },
                ready(channels) {
                    const open = new Set(channels)
                    for (const channel of channels) if (!sessions.has(channel)) client.close(channel)
                    for (const [channel, session] of sessions) if (!open.has(channel)) { session.closed(); sessions.delete(channel) }
                },
            },
        })
        return client
    }

    async function sync(): Promise<VoiceEngineSettings> {
        const settings = await deps.store.read()
        const wanted = !closed && settings.enabled && settings.relayOrigin && settings.installId && settings.hasSecret
        const identity = wanted ? JSON.stringify([settings.relayOrigin, settings.installId]) : null
        if (relay && relayIdentity !== identity) {
            relay.stop()
            relay = null
            endSessions()
            minted.clear()
        }
        if (identity && !relay) {
            relay = openRelay(settings as VoiceEngineSettings & { relayOrigin: string; installId: string })
            relayIdentity = identity
            relay.start()
        }
        relayIdentity = relay ? identity : null
        return settings
    }

    async function status(): Promise<DesktopVoiceEngineStatus> {
        const [settings, key] = await Promise.all([sync(), deps.keyInfo()])
        const engineStale = !!settings.engineId && (settings.engineKeyRevision !== key.revision || settings.engineRelay !== settings.relayOrigin)
        return {
            relayOrigin: settings.relayOrigin, enabled: settings.enabled, keySaved: key.configured,
            engineReady: !!settings.engineId && !engineStale && key.configured, engineStale,
            relayConnected: !!relay?.connected,
        }
    }

    return {
        sync, status,
        async saveRelay(input: string): Promise<{ status: DesktopVoiceEngineStatus; deploy?: DesktopVoiceRelayDeploy }> {
            const origin = desktopVoiceRelayOrigin(input)
            if (!origin) throw new DesktopHttpError(400, 'Enter the https address of your relay, like https://voice.example.com.')
            const deploy = await deps.store.saveRelay(origin)
            return { status: await status(), ...(deploy && { deploy }) }
        },
        async rotate() {
            const deploy = await deps.store.rotate()
            return { status: await status(), deploy }
        },
        async createEngine(signal: AbortSignal) {
            const settings = await deps.store.read()
            if (!settings.relayOrigin || !settings.installId) throw new DesktopHttpError(409, 'Save your relay address first.')
            const saved = await deps.readKey()
            if (!saved) throw new DesktopHttpError(409, 'Add an ElevenLabs key in Settings, under Tool services, first.', 'speech_no_key')
            const { engineId } = await deps.api.createEngine({ apiKey: saved.key, wsUrl: relaySpeechEngineUrl(settings.relayOrigin, settings.installId), voiceId: await deps.voiceId() }, signal)
            await deps.store.setEngine(engineId, saved.revision, settings.relayOrigin)
            return { status: await status() }
        },
        async setEnabled(enabled: boolean) {
            if (enabled && !(await deps.store.read()).relayOrigin) throw new DesktopHttpError(409, 'Save your relay address first.')
            await deps.store.setEnabled(enabled)
            return { status: await status() }
        },
        async forget() {
            await deps.store.forget()
            return { status: await status() }
        },
        /**
         * For a paired phone: a short-lived ElevenLabs token for one conversation, spoken on the Chief
         * of Staff conversation `chat`. Refused when the feature is off, and when the relay is not connected.
         */
        async startConversation(chat: DesktopForemanChatRef, signal: AbortSignal): Promise<VoiceConversationGrant> {
            const settings = await sync()
            if (!settings.enabled || !settings.relayOrigin) throw off()
            const key = await deps.keyInfo()
            if (!settings.engineId || !key.configured || settings.engineKeyRevision !== key.revision || settings.engineRelay !== settings.relayOrigin) throw unavailable()
            if (!relay?.connected) throw unavailable()
            await deps.chief.assertChat(chat)
            const saved = await deps.readKey()
            if (!saved) throw unavailable()
            const { token, conversationId } = await deps.api.conversationToken({ apiKey: saved.key, engineId: settings.engineId }, signal)
            const expiresAt = minted.mint(conversationId, chat)
            if (!relay || !(await relay.announce(conversationId, MINTED_TTL_MS))) {
                minted.withdraw(conversationId)
                throw unavailable()
            }
            return { conversationToken: token, conversationId, expiresAt: new Date(expiresAt).toISOString() }
        },
        close() {
            closed = true
            relay?.stop()
            relay = null
            relayIdentity = null
            endSessions()
            minted.clear()
        },
    }
}
export type VoiceEngineService = ReturnType<typeof createVoiceEngineService>
