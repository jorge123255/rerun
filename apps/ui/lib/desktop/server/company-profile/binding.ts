import 'server-only'
import type { Client } from '@libsql/client'
import {
    foremanChatRefSchema,
    type CompanyBriefModelRef,
    type DesktopCompanyDiscoverySnapshot,
    type DesktopCompanyProfileCancelInput,
    type DesktopCompanyProfileDecideInput,
    type DesktopCompanyProfileEnrichInput,
    type DesktopForemanChatRef,
} from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { ownedForemanChat } from '../foreman/chat-store'
import { readDesktopForemanIntakeProfile } from '../foreman/intake-profile'
import { createSqliteDesktopForemanIntakeStore } from '../foreman-intake'
import type { DesktopRuntime } from '../runtime'
import { createDesktopLocalProfileActorAuthority } from './actor'
import { createDesktopCompanyProfileEngineClient, type DesktopCompanyProfileEngineClient } from './client'
import { collectDesktopCompanyProfileEvidence, type DesktopCompanyProfileCollector } from './collector'
import { DesktopCompanyProfileError } from './errors'
import { assertDesktopCompanyProfileIdentity } from './identity'
import { createDesktopCompanyProfileService, type DesktopCompanyProfileCanonicalAuthority, type DesktopCompanyProfileServicePorts } from './service'
import { createSqliteDesktopCompanyProfileStore, type DesktopCompanyProfileStore } from './store'

export type DesktopCompanyProfileForemanApp = {
    db: Client
    companyDiscovery: {
        read(input: { workspaceId: string; chatId: string }): Promise<
            | { state: 'present'; snapshot: DesktopCompanyDiscoverySnapshot }
            | { state: 'absent' }
            | { state: 'unknown'; discoveryId: string }
        >
    }
    modelChoice(chat: DesktopForemanChatRef): Promise<CompanyBriefModelRef>
}

export function createDesktopCompanyProfileBinding(
    runtime: DesktopRuntime,
    app: DesktopCompanyProfileForemanApp,
    options?: {
        store?: DesktopCompanyProfileStore
        engine?: DesktopCompanyProfileEngineClient
        collector?: DesktopCompanyProfileCollector
        actor?: DesktopCompanyProfileServicePorts['actor']
        now?: () => string
    },
) {
    const own = async (raw: DesktopForemanChatRef) => {
        const chat = foremanChatRefSchema.parse(raw)
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Foreman conversation not found.')
        await ownedForemanChat(app.db, chat)
        return chat
    }
    const intake = createSqliteDesktopForemanIntakeStore(app.db, { schemaReady: true })
    const canonical: DesktopCompanyProfileCanonicalAuthority = {
        read: async raw => {
            const chat = await own(raw)
            const [view, accepted, discovery] = await Promise.all([
                intake.read(chat),
                readDesktopForemanIntakeProfile(app.db, chat),
                app.companyDiscovery.read({ workspaceId: chat.workspaceId, chatId: chat.chatId }),
            ])
            if (discovery.state === 'unknown') throw new DesktopCompanyProfileError('storage', 'The saved company discovery identity could not be confirmed.')
            return { session: view.session, accepted, discovery: discovery.state === 'present' ? discovery.snapshot : null }
        },
        require: async (identity, kind) => {
            const context = await canonical.read(identity.chat)
            assertDesktopCompanyProfileIdentity(context, identity, kind)
            return context
        },
    }
    const selected = async (chat: DesktopForemanChatRef): Promise<CompanyBriefModelRef | null> => {
        await own(chat)
        try { return await app.modelChoice(chat) }
        catch (error) {
            if (error instanceof DesktopHttpError && error.status === 409) return null
            throw error
        }
    }
    const service = createDesktopCompanyProfileService({
        store: options?.store ?? createSqliteDesktopCompanyProfileStore(app.db, { schemaReady: true }),
        canonical,
        models: { decision: selected, profile: selected },
        engine: options?.engine ?? createDesktopCompanyProfileEngineClient(runtime),
        collector: options?.collector ?? collectDesktopCompanyProfileEvidence,
        actor: options?.actor ?? createDesktopLocalProfileActorAuthority(app.db),
        now: options?.now,
    })
    let ready: Promise<void> | null = null
    const initialize = () => (ready ??= service.reconcile())
    return {
        async read(chat: DesktopForemanChatRef) { await own(chat); await initialize(); return service.read(chat) },
        async decide(input: DesktopCompanyProfileDecideInput, access?: { signal?: AbortSignal }) {
            await own(input.identity.chat); await initialize(); return service.decide(input, access)
        },
        async enrich(input: DesktopCompanyProfileEnrichInput, access?: { signal?: AbortSignal }) {
            await own(input.identity.chat); await initialize(); return service.enrich(input, access)
        },
        async cancel(input: DesktopCompanyProfileCancelInput) {
            await own(input.chat); await initialize(); return service.cancel(input)
        },
        async decideIndustry(chat: DesktopForemanChatRef) { await own(chat); await initialize(); return service.decideIndustry(chat) },
        async analyzeSite(chat: DesktopForemanChatRef) { await own(chat); await initialize(); return service.analyzeSite(chat) },
        async resolveKnownFirstName(chat: DesktopForemanChatRef) { await own(chat); await initialize(); return service.resolveKnownFirstName(chat) },
        async cancelChat(chat: DesktopForemanChatRef) { await own(chat); await initialize(); return service.cancelChat(chat) },
        async reconcile() { await initialize() },
        async close() { await service.close() },
    }
}

export type DesktopCompanyProfileBinding = ReturnType<typeof createDesktopCompanyProfileBinding>

const BINDINGS = Symbol.for('rerun.desktop.company-profile.bindings.v1')
const bindings = () => ((globalThis as unknown as Record<symbol, Map<string, DesktopCompanyProfileBinding>>)[BINDINGS] ??= new Map())

function bindingKey(runtime: DesktopRuntime): string {
    return JSON.stringify([runtime.dataRoot, String(runtime.workspaceId), runtime.launchNonce, runtime.engine.origin])
}

export function desktopCompanyProfile(runtime: DesktopRuntime, app: DesktopCompanyProfileForemanApp): DesktopCompanyProfileBinding {
    const key = bindingKey(runtime)
    let binding = bindings().get(key)
    if (!binding) {
        binding = createDesktopCompanyProfileBinding(runtime, app)
        bindings().set(key, binding)
    }
    return binding
}

export async function shutdownDesktopCompanyProfile(runtime: DesktopRuntime): Promise<void> {
    const key = bindingKey(runtime)
    const existing = bindings().get(key)
    if (!existing) return
    await existing.close()
    if (bindings().get(key) === existing) bindings().delete(key)
}
