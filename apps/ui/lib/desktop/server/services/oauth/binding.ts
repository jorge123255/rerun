import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { DesktopRuntime } from '../../runtime'
import type { ServiceInstall, ServiceStore } from '../store'
import type { LocalServices, ServiceRun } from '../lifecycle'
import type { AccountFeature } from '../accounts/feature'
import type { AccountCompilePlan } from '../accounts/compiler'
import { getDesktopServiceManifest } from '../catalog/index'
import { compileCatalogOAuth } from './compiler'
import { sqliteServiceOAuthStore } from './store'
import { catalogOAuthPrimitive } from './primitive'
import { serviceOAuthLifecycle } from './lifecycle'
import type { OAuthAccountBinding, OAuthAccounts } from './ports'
import type { DesktopServiceOAuthAction } from '../../../../../../../packages/contracts/src/desktop-service-oauth'
import { desktopServiceOAuthSnapshotSchema } from '../../../../../../../packages/contracts/src/desktop-service-oauth'

export function createCanonicalServiceOAuth(runtime: DesktopRuntime, store: ServiceStore, services: LocalServices, feature: AccountFeature, key: () => Buffer, shutdownSignal: AbortSignal) {
    const attemptStore = sqliteServiceOAuthStore(store.db, key)
    const readiness = new AsyncLocalStorage<{ installationId: string; generation: string; credential: () => Promise<string> }>()
    const gesture = new AsyncLocalStorage<{ owner: string; requestId: string }>()
    const links = new Map<string, string>()
    const linkKey = (owner: string, requestId: string) => JSON.stringify([owner, requestId])
    function binding(record: ServiceInstall): OAuthAccountBinding {
        const plan = record.plan as AccountCompilePlan
        if (plan.shape !== 'oauth' || !plan.oauthFingerprint || !['ready', 'preparing'].includes(record.state)) throw new Error('This account is not configured for OAuth.')
        const manifest = getDesktopServiceManifest(plan.slug).manifest, declared = compileCatalogOAuth(manifest, plan.methodId)
        if (declared.fingerprint !== plan.oauthFingerprint || declared.endpoint !== plan.url) throw new Error('OAuth catalog configuration changed.')
        return { owner: record.owner, engineId: record.engineId, installationId: record.id, accountKey: record.key, label: plan.label, methodId: plan.methodId, configGeneration: record.revision, endpoint: plan.url, transport: 'http', catalogFingerprint: declared.fingerprint, serverName: plan.serverName }
    }
    async function current(owner: string, accountKey: string, signal: AbortSignal) {
        signal.throwIfAborted(); shutdownSignal.throwIfAborted()
        const authority = await services.current(owner, 'manage', undefined, signal), record = await store.read(owner, accountKey)
        if (!record || record.engineId !== authority.engineAgentId) throw new Error('OAuth account ownership changed.')
        const bound = binding(record)
        authority.check?.(); signal.throwIfAborted(); shutdownSignal.throwIfAborted()
        const checked = Date.parse(record.health.checkedAt ?? '')
        return { binding: bound, enabled: authority.enabled, granted: authority.granted, healthy: record.state === 'ready' && record.health.state === 'healthy' && record.healthLaunch === runtime.launchNonce && Number.isFinite(checked) && Date.now() - checked < 60_000 }
    }
    const accounts: OAuthAccounts = {
        async catalog(slug) { try { return getDesktopServiceManifest(slug).manifest } catch { return null } },
        current,
        async configure(owner, requestId, intent, plan, signal) {
            if (intent.kind === 'existing') {
                const existing = await current(owner, intent.accountKey, signal)
                if (existing.binding.configGeneration !== intent.expectedRevision || existing.binding.catalogFingerprint !== plan.fingerprint) throw new Error('OAuth account changed.')
                return existing.binding
            }
            const result = await feature.mutate(owner, { action: 'install', requestId, intent, authMethodId: plan.methodId, values: {} }, signal)
            if (!result.accountKey || !result.installationId || !result.revision || result.status === 'unknown') throw new Error('OAuth configuration acknowledgement unavailable.')
            const saved = await current(owner, result.accountKey, signal)
            if (saved.binding.installationId !== result.installationId || saved.binding.configGeneration !== result.revision || saved.binding.catalogFingerprint !== plan.fingerprint) throw new Error('OAuth account changed.')
            return saved.binding
        },
        exclusive: (owner, _id, work) => services.accountMutation(owner, true, work),
        async readiness(bound, credential, signal) {
            const initial = await current(bound.owner, bound.accountKey, signal)
            if (JSON.stringify(initial.binding) !== JSON.stringify(bound)) throw new Error('OAuth account changed.')
            return readiness.run({ installationId: bound.installationId, generation: bound.configGeneration, credential }, async () => {
                const record = await services.liveRecord(bound.owner, bound.accountKey, bound.configGeneration, signal)
                await services.discover(record, undefined, signal)
                return { healthy: (await current(bound.owner, bound.accountKey, signal)).healthy }
            })
        },
        async disconnect(bound, signal) {
            const record = await store.read(bound.owner, bound.accountKey)
            if (!record || record.id !== bound.installationId || record.revision !== bound.configGeneration) throw new Error('OAuth account changed.')
            await services.lifecycle.mutate(bound.owner, services.idName(record), async () => {
                const authority = await services.current(bound.owner, 'manage', undefined, signal)
                if (record.engineId !== authority.engineAgentId) throw new Error('OAuth owner changed.')
                await store.update({ ...record, state: 'ready', toolNames: [], health: { state: 'disconnected' }, healthLaunch: null }, record.revision)
                await services.syncRegistry(authority.skillsRoot, bound.owner, signal)
            })
        },
    }
    const lifecycle = serviceOAuthLifecycle(accounts, attemptStore, catalogOAuthPrimitive(accounts, attemptStore), async (url, signal) => {
        signal.throwIfAborted(); shutdownSignal.throwIfAborted()
        const action = gesture.getStore()
        if (!action) throw new Error('OAuth sign-in requires an explicit connection action.')
        links.set(linkKey(action.owner, action.requestId), url)
    })
    shutdownSignal.addEventListener('abort', () => { lifecycle.shutdown(); links.clear() }, { once: true })
    return {
        ...lifecycle,
        async action(owner: string, input: DesktopServiceOAuthAction, signal: AbortSignal) {
            const snapshot = await gesture.run({ owner, requestId: input.action === 'start' || input.action === 'configure' || input.action === 'lookup' ? input.requestId : '' }, () => lifecycle.action(owner, input, signal))
            const saved = await attemptStore.read(owner, snapshot.attemptId)
            const url = saved && snapshot.state === 'waiting' ? links.get(linkKey(owner, saved.requestId)) : undefined
            return desktopServiceOAuthSnapshotSchema.parse({ ...snapshot, ...(url ? { authorizationUrl: url } : {}) })
        },
        async credentialFor(record: ServiceInstall, run: ServiceRun | undefined, signal: AbortSignal) {
            const authority = await services.current(record.owner, 'use', run, signal)
            if (record.engineId !== authority.engineAgentId) throw new Error('OAuth tool owner changed.')
            const scoped = readiness.getStore()
            if (scoped?.installationId === record.id && scoped.generation === record.revision) return scoped.credential()
            const now = await current(record.owner, record.key, signal)
            if (now.binding.installationId !== record.id || now.binding.configGeneration !== record.revision) throw new Error('OAuth account changed.')
            const matches = (await attemptStore.list(record.owner)).filter(row => row.binding.installationId === record.id && row.binding.configGeneration === record.revision && row.snapshot.state === 'connected')
            if (matches.length !== 1) throw new Error('Connect and check this OAuth account before using its tools.')
            return lifecycle.credential(record.owner, matches[0].snapshot.attemptId, signal)
        },
        async suspendOwner(owner: string) {
            await lifecycle.suspendOwner(owner)
            for (const record of await store.list(owner)) if ((record.plan as Partial<AccountCompilePlan>).shape === 'oauth') await store.update({ ...record, health: { state: 'unchecked' }, healthLaunch: null, toolNames: [] }, record.revision)
        },
        async invalidateOwner(owner: string) { for (const id of new Set((await attemptStore.list(owner)).map(row => row.binding.installationId))) await lifecycle.invalidateAccount(owner, id) },
    }
}
