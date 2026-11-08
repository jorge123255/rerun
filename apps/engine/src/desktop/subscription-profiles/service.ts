import { randomUUID } from 'node:crypto'
import { builtinSubscriptionProfile, subscriptionAdapterCapabilities } from './capabilities.js'
import {
    DESKTOP_SUBSCRIPTION_PROFILES_CONTRACT_VERSION, SUBSCRIPTION_PROFILE_BOUND, SUBSCRIPTION_PROFILE_DRAIN, SUBSCRIPTION_PROFILE_LIMIT, SUBSCRIPTION_PROFILE_NOT_READY, SUBSCRIPTION_PROFILE_PENDING, SUBSCRIPTION_PROFILE_UNKNOWN,
    desktopSubscriptionCredentialGenerationSchema, desktopSubscriptionExecutionSnapshotSchema, desktopSubscriptionProfileCatalogSchema, desktopSubscriptionProfileIdSchema, desktopSubscriptionProfileViewSchema,
    type DesktopSubscriptionCaptureInput, type DesktopSubscriptionCredentialGeneration, type DesktopSubscriptionExecutionSnapshot, type DesktopSubscriptionMutationReceipt, type DesktopSubscriptionNameInput, type DesktopSubscriptionPendingRun, type DesktopSubscriptionProfileProvider, type DesktopSubscriptionRemoveInput, type DesktopSubscriptionSelectInput,
} from './contract.js'
import type { SubscriptionProfileRow, SubscriptionProfileStore, SubscriptionReceiptRow, SubscriptionRunBinding } from './store.js'

export type SubscriptionProfileCustody = {
    workspaceId: number
    pendingRuns(connectionId: 'mac-chatgpt' | 'mac-claude'): Promise<DesktopSubscriptionPendingRun[]>
    stopAndDrain?(connectionId: 'mac-chatgpt' | 'mac-claude'): Promise<'stopped' | 'unknown'>
    credentialGeneration(connectionId: 'mac-chatgpt' | 'mac-claude'): Promise<DesktopSubscriptionCredentialGeneration | null>
    credentialMetadataPresent(connectionId: 'mac-chatgpt' | 'mac-claude'): Promise<boolean>
}

export class SubscriptionProfileRefusal extends Error {
    constructor(message: string) { super(message); this.name = 'SubscriptionProfileRefusal' }
}

const providers: DesktopSubscriptionProfileProvider[] = ['chatgpt', 'claude']

function publicBody(value: unknown): string {
    return JSON.stringify(value)
}

function sameWorkspace(custody: SubscriptionProfileCustody, workspaceId: number) {
    if (workspaceId !== custody.workspaceId) throw new SubscriptionProfileRefusal('That profile is not in this workspace.')
}

export function createSubscriptionProfileService(options: { store: SubscriptionProfileStore; custody: SubscriptionProfileCustody; now?: () => Date }) {
    const now = options.now ?? (() => new Date())
    const stamp = () => now().toISOString()

    async function remembered(workspaceId: number, requestId: string, body: string): Promise<SubscriptionReceiptRow | null> {
        const existing = await options.store.receipt(workspaceId, requestId)
        if (!existing) return null
        if (existing.publicBody !== body) throw new SubscriptionProfileRefusal('This request was already used.')
        return existing
    }

    async function finish(row: SubscriptionReceiptRow, extra?: { snapshot?: DesktopSubscriptionExecutionSnapshot }): Promise<{ receipt: DesktopSubscriptionMutationReceipt; snapshot?: DesktopSubscriptionExecutionSnapshot }> {
        await options.store.putReceipt(row)
        const receipt: DesktopSubscriptionMutationReceipt = {
            version: 1, requestId: row.requestId, kind: row.kind, status: row.status, workspaceId: row.workspaceId,
            profileId: desktopSubscriptionProfileIdSchema.nullable().parse(row.profileId),
            credentialGeneration: row.credentialGeneration ? desktopSubscriptionCredentialGenerationSchema.parse(row.credentialGeneration) : null,
            message: row.message, createdAt: row.createdAt,
        }
        return extra?.snapshot ? { receipt, snapshot: extra.snapshot } : { receipt }
    }

    function receiptOf(existing: SubscriptionReceiptRow): { receipt: DesktopSubscriptionMutationReceipt } {
        return { receipt: { version: 1, requestId: existing.requestId, kind: existing.kind, status: existing.status, workspaceId: existing.workspaceId, profileId: desktopSubscriptionProfileIdSchema.nullable().parse(existing.profileId), credentialGeneration: existing.credentialGeneration ? desktopSubscriptionCredentialGenerationSchema.parse(existing.credentialGeneration) : null, message: existing.message, createdAt: existing.createdAt } }
    }

    async function generationOf(connectionId: 'mac-chatgpt' | 'mac-claude'): Promise<DesktopSubscriptionCredentialGeneration | null> {
        try {
            const value = await options.custody.credentialGeneration(connectionId)
            return value ? desktopSubscriptionCredentialGenerationSchema.parse(value) : null
        } catch { return null }
    }

    async function viewNamed(row: SubscriptionProfileRow) {
        return desktopSubscriptionProfileViewSchema.parse({
            version: DESKTOP_SUBSCRIPTION_PROFILES_CONTRACT_VERSION, workspaceId: row.workspaceId, profileId: row.profileId, provider: row.provider, displayName: row.displayName,
            connectionId: null, credentialGeneration: null, credentialMetadataPresent: false, providerReady: false, availability: 'unavailable', selectable: false,
            reason: subscriptionAdapterCapabilities[row.provider].reason,
        })
    }

    async function catalog(workspaceId: number) {
        sameWorkspace(options.custody, workspaceId)
        const stored = await options.store.profiles(workspaceId)
        const profiles = []
        const explicitSelections = []
        for (const provider of providers) {
            const builtin = builtinSubscriptionProfile[provider]
            const generation = await generationOf(builtin.connectionId)
            let metadata = false
            try { metadata = await options.custody.credentialMetadataPresent(builtin.connectionId) } catch { metadata = false }
            const selected = stored.find(row => row.profileId === builtin.profileId && row.explicit)
            profiles.push(desktopSubscriptionProfileViewSchema.parse({
                version: 1, workspaceId, profileId: builtin.profileId, provider, displayName: builtin.displayName, connectionId: builtin.connectionId,
                credentialGeneration: generation, credentialMetadataPresent: metadata, providerReady: false, availability: 'current-session', selectable: true,
                reason: subscriptionAdapterCapabilities[provider].reason,
            }))
            if (selected) explicitSelections.push({ provider, profileId: builtin.profileId, connectionId: builtin.connectionId, credentialGeneration: generation })
            for (const row of stored.filter(item => item.provider === provider && item.profileId !== builtin.profileId)) profiles.push(await viewNamed(row))
        }
        return desktopSubscriptionProfileCatalogSchema.parse({ version: 1, workspaceId, capabilities: providers.map(provider => subscriptionAdapterCapabilities[provider]), profiles, explicitSelections })
    }

    async function name(input: DesktopSubscriptionNameInput) {
        sameWorkspace(options.custody, input.workspaceId)
        const body = publicBody(input)
        const existing = await remembered(input.workspaceId, input.requestId, body)
        if (existing) return receiptOf(existing)
        const profileId = `spr_${randomUUID()}`
        const createdAt = stamp()
        await options.store.putProfile({ workspaceId: input.workspaceId, profileId, provider: input.provider, displayName: input.displayName, connectionId: null, credentialGeneration: null, explicit: false, availability: 'unavailable', createdAt, updatedAt: createdAt })
        return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'name', publicBody: body, status: 'saved', profileId, credentialGeneration: null, message: 'The profile is saved as unavailable. It has no credential and cannot run.', createdAt })
    }

    async function select(input: DesktopSubscriptionSelectInput) {
        sameWorkspace(options.custody, input.workspaceId)
        const body = publicBody(input)
        const existing = await remembered(input.workspaceId, input.requestId, body)
        if (existing) return receiptOf(existing)
        const provider = input.profileId === builtinSubscriptionProfile.chatgpt.profileId ? 'chatgpt' : input.profileId === builtinSubscriptionProfile.claude.profileId ? 'claude' : null
        const createdAt = stamp()
        if (!provider) {
            return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'select', publicBody: body, status: 'refused', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_LIMIT, createdAt })
        }
        const builtin = builtinSubscriptionProfile[provider]
        const generation = await generationOf(builtin.connectionId)
        if (input.expectedGeneration !== generation) throw new SubscriptionProfileRefusal('That session changed. Review it again.')
        const rows = await options.store.profiles(input.workspaceId)
        await options.store.putProfile({ workspaceId: input.workspaceId, profileId: builtin.profileId, provider, displayName: builtin.displayName, connectionId: builtin.connectionId, credentialGeneration: generation, explicit: true, availability: 'current-session', createdAt: rows.find(row => row.profileId === builtin.profileId)?.createdAt ?? createdAt, updatedAt: createdAt })
        return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'select', publicBody: body, status: 'saved', profileId: builtin.profileId, credentialGeneration: generation, message: 'The existing session stays selected. No other account was signed in.', createdAt })
    }

    async function capture(input: DesktopSubscriptionCaptureInput): Promise<{ receipt: DesktopSubscriptionMutationReceipt; snapshot?: DesktopSubscriptionExecutionSnapshot }> {
        sameWorkspace(options.custody, input.workspaceId)
        const body = publicBody({ ...input })
        const existing = await remembered(input.workspaceId, input.requestId, body)
        if (existing?.status === 'saved') {
            const saved = await options.store.binding(input.workspaceId, input.runId)
            return saved ? { ...receiptOf(existing), snapshot: desktopSubscriptionExecutionSnapshotSchema.parse({ version: 1, ...saved }) } : receiptOf(existing)
        }
        if (existing) return receiptOf(existing)
        const provider = (Object.keys(builtinSubscriptionProfile) as DesktopSubscriptionProfileProvider[]).find(item => builtinSubscriptionProfile[item].profileId === input.profileId)
        const createdAt = stamp()
        if (!provider) return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'capture', publicBody: body, status: 'refused', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_LIMIT, createdAt })
        const builtin = builtinSubscriptionProfile[provider]
        const generation = await generationOf(builtin.connectionId)
        if (!generation) return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'capture', publicBody: body, status: 'refused', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_NOT_READY, createdAt })
        const prior = await options.store.binding(input.workspaceId, input.runId)
        if (prior && (prior.profileId !== input.profileId || prior.credentialGeneration !== generation || prior.ownerId !== input.ownerId || prior.agentId !== input.agentId || prior.sessionId !== input.sessionId)) {
            return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'capture', publicBody: body, status: 'refused', profileId: prior.profileId, credentialGeneration: prior.credentialGeneration, message: SUBSCRIPTION_PROFILE_BOUND, createdAt })
        }
        const snapshot = desktopSubscriptionExecutionSnapshotSchema.parse({ version: 1, workspaceId: input.workspaceId, ownerId: input.ownerId, agentId: input.agentId, provider, profileId: builtin.profileId, connectionId: builtin.connectionId, credentialGeneration: generation, runId: input.runId, sessionId: input.sessionId, capturedAt: createdAt })
        if (!prior) await options.store.putBinding(snapshot)
        return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'capture', publicBody: body, status: 'saved', profileId: builtin.profileId, credentialGeneration: generation, message: 'The run is bound to this session generation.', createdAt }, { snapshot })
    }

    async function admit(snapshot: DesktopSubscriptionExecutionSnapshot): Promise<DesktopSubscriptionExecutionSnapshot> {
        const parsed = desktopSubscriptionExecutionSnapshotSchema.parse(snapshot)
        sameWorkspace(options.custody, parsed.workspaceId)
        const saved = await options.store.binding(parsed.workspaceId, parsed.runId)
        if (!saved || saved.ownerId !== parsed.ownerId || saved.agentId !== parsed.agentId || saved.profileId !== parsed.profileId || saved.connectionId !== parsed.connectionId || saved.credentialGeneration !== parsed.credentialGeneration || saved.sessionId !== parsed.sessionId) throw new SubscriptionProfileRefusal(SUBSCRIPTION_PROFILE_BOUND)
        const current = await generationOf(parsed.connectionId)
        const recorded = (await options.store.profiles(parsed.workspaceId)).find(row => row.profileId === parsed.profileId)?.credentialGeneration
        if (current !== parsed.credentialGeneration || (recorded !== undefined && recorded !== null && recorded !== parsed.credentialGeneration)) throw new SubscriptionProfileRefusal(SUBSCRIPTION_PROFILE_BOUND)
        return parsed
    }

    async function recordGeneration(input: { requestId: string; workspaceId: number; connectionId: 'mac-chatgpt' | 'mac-claude'; credentialGeneration: DesktopSubscriptionCredentialGeneration }) {
        sameWorkspace(options.custody, input.workspaceId)
        const body = publicBody(input)
        const existing = await remembered(input.workspaceId, input.requestId, body)
        if (existing) return receiptOf(existing)
        const provider = input.connectionId === 'mac-chatgpt' ? 'chatgpt' : 'claude'
        const builtin = builtinSubscriptionProfile[provider]
        const createdAt = stamp()
        const rows = await options.store.profiles(input.workspaceId)
        const current = rows.find(row => row.profileId === builtin.profileId)
        await options.store.putProfile({ workspaceId: input.workspaceId, profileId: builtin.profileId, provider, displayName: builtin.displayName, connectionId: builtin.connectionId, credentialGeneration: input.credentialGeneration, explicit: current?.explicit ?? false, availability: 'current-session', createdAt: current?.createdAt ?? createdAt, updatedAt: createdAt })
        return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'generation', publicBody: body, status: 'saved', profileId: builtin.profileId, credentialGeneration: input.credentialGeneration, message: 'The session generation changed. Runs already bound keep their original generation.', createdAt })
    }

    async function remove(input: DesktopSubscriptionRemoveInput) {
        sameWorkspace(options.custody, input.workspaceId)
        const body = publicBody(input)
        const existing = await remembered(input.workspaceId, input.requestId, body)
        if (existing) return receiptOf(existing)
        const createdAt = stamp()
        const builtin = (Object.keys(builtinSubscriptionProfile) as DesktopSubscriptionProfileProvider[]).find(provider => builtinSubscriptionProfile[provider].profileId === input.profileId)
        if (!builtin) {
            const rows = await options.store.profiles(input.workspaceId)
            if (!rows.some(row => row.profileId === input.profileId)) return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'refused', profileId: input.profileId, credentialGeneration: null, message: 'That profile is not in this workspace.', createdAt })
            const bindings = await options.store.bindingsForProfile(input.workspaceId, input.profileId)
            if (bindings.length) return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'refused', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_BOUND, createdAt })
            await options.store.deleteProfile(input.workspaceId, input.profileId)
            return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'saved', profileId: input.profileId, credentialGeneration: null, message: 'The unavailable profile was removed. No credential was stored for it.', createdAt })
        }
        const connectionId = builtinSubscriptionProfile[builtin].connectionId
        let pending: DesktopSubscriptionPendingRun[]
        try { pending = await options.custody.pendingRuns(connectionId) } catch { return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'refused', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_DRAIN, createdAt }) }
        if (pending.length) return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'refused', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_PENDING, createdAt })
        if (!options.custody.stopAndDrain) return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'refused', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_DRAIN, createdAt })
        const stopped = await options.custody.stopAndDrain(connectionId).catch(() => 'unknown' as const)
        if (stopped !== 'stopped') return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'uncertain', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_UNKNOWN, createdAt })
        const again = await options.custody.pendingRuns(connectionId).catch(() => null)
        if (!again || again.length) return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'uncertain', profileId: input.profileId, credentialGeneration: null, message: SUBSCRIPTION_PROFILE_UNKNOWN, createdAt })
        const rows = await options.store.profiles(input.workspaceId)
        const current = rows.find(row => row.profileId === input.profileId)
        if (current) await options.store.putProfile({ ...current, explicit: false, updatedAt: createdAt })
        return finish({ workspaceId: input.workspaceId, requestId: input.requestId, kind: 'remove', publicBody: body, status: 'saved', profileId: input.profileId, credentialGeneration: current?.credentialGeneration ?? null, message: 'The explicit selection was cleared. The connection credential was not copied or deleted.', createdAt })
    }

    return { catalog, name, select, capture, admit, recordGeneration, remove }
}
