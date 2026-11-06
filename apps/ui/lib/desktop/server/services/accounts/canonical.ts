import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { desktopServiceAccountMutationSchema } from '@rerun/contracts'
import type { DesktopRuntime } from '../../runtime'
import type { LocalServices } from '../lifecycle'
import type { OwnedSkill, ServiceInstall, ServiceStore } from '../store'
import { currentSkillInstallation, type SkillReservation } from '../skill-journal'
import { acknowledgeServiceSkill, createServiceSkill, removeServiceSkill, resolveServiceSkillRemoval, verifyServiceSkill } from '../skill-resources'
import type { AccountFeature } from './feature'
import type { AccountInstallPort, AccountInstallRecord } from './installs'
import type { AccountSkillPort } from './lifecycle'
import { legacyCompatibleHeaderSecrets, sqliteHeaderSecrets } from './secret-store'
import { canonicalAccountTransport } from './canonical-transport'
import { openDesktopServiceAccounts } from './wire'
import { accountAttempts } from './attempts'

const sameResource = (a: OwnedSkill, b: OwnedSkill) => a.slug === b.slug && a.directoryIdentity === b.directoryIdentity && a.manifestVersion === b.manifestVersion && a.contentHash === b.contentHash

/** One feature per canonical MCP binding; no route-local credentials/runtime. */
export async function canonicalServiceAccounts(runtime: DesktopRuntime, store: ServiceStore, services: LocalServices, keyReader: () => Buffer): Promise<AccountFeature> {
    type Scope = { owner: string; signal: AbortSignal; authority: Awaited<ReturnType<LocalServices['current']>> }
    const context = new AsyncLocalStorage<Scope>()
    const scope = () => { const value = context.getStore(); if (!value) throw new Error('Account mutation authority unavailable'); return value }
    const guard = async (record?: ServiceInstall) => {
        const value = scope(), current = await services.current(value.owner, 'manage', undefined, value.signal)
        if (current.engineAgentId !== value.authority.engineAgentId || current.skillsRoot !== value.authority.skillsRoot || current.runtime.launchNonce !== value.authority.runtime.launchNonce) throw new Error('Service owner changed')
        if (record) {
            if (record.owner !== value.owner || record.engineId !== current.engineAgentId) throw new Error('Service installation owner changed')
            await currentSkillInstallation(store, record)
        }
        return value
    }
    const byId = async (id: string) => {
        const value = await guard(), record = (await store.list(value.owner)).find(row => row.id === id)
        if (!record) throw new Error('Service installation unavailable')
        await guard(record)
        return record
    }
    const publish = async (record: { id: string }) => {
        const current = await byId(record.id), value = await guard(current)
        for (const owned of current.skills) {
            const reservation = (await services.skillJournal.list(current.owner)).find(row => row.installationId === current.id && row.resource && sameResource(row.resource, owned))
            if (!reservation || reservation.engineId !== current.engineId) throw new Error('Service skill ownership unavailable')
            await verifyServiceSkill(value.authority.skillsRoot, owned)
            await acknowledgeServiceSkill(services.skillJournal, reservation)
        }
        await guard(current)
        await services.syncRegistry(value.authority.skillsRoot, value.owner, value.signal)
    }
    const removeReserved = async (record: ServiceInstall, reservation: SkillReservation, outerGuard: () => Promise<void>) => {
        const value = await guard(record)
        if (reservation.engineId !== record.engineId || reservation.installationId !== record.id || reservation.owner !== record.owner) throw new Error('Service skill owner changed')
        if (reservation.state === 'removed') return
        if (!reservation.resource) throw new Error('Unacknowledged staging resource; preserved for explicit recovery')
        const exactGuard = async () => { await outerGuard(); await guard(record) }
        const refs = (await store.list(record.owner)).filter(row => row.id !== record.id).flatMap(row => row.skills)
        if (refs.some(owned => owned.slug === reservation.resource!.slug || owned.directoryIdentity === reservation.resource!.directoryIdentity)) throw new Error('Service skill is still referenced')
        const resource = await resolveServiceSkillRemoval(value.authority.skillsRoot, reservation, exactGuard)
        await removeServiceSkill(value.authority.skillsRoot, resource, exactGuard)
        await services.skillJournal.update(reservation, 'removed', reservation.resource)
    }
    const skills: AccountSkillPort = {
        async create(root, installationId, index, skill, outerGuard) {
            const record = await byId(installationId), value = await guard(record)
            if (root !== value.authority.skillsRoot) throw new Error('Service skill root changed')
            return createServiceSkill(root, record, index, skill, async () => { await outerGuard(); await guard(record) }, services.skillJournal)
        },
        async verify(root, owned) {
            const value = await guard()
            if (root !== value.authority.skillsRoot) throw new Error('Service skill root changed')
            const record = (await store.list(value.owner)).find(row => row.skills.some(resource => sameResource(resource, owned)))
            if (!record) throw new Error('Service skill projection unavailable')
            // Also recovers a crash after the exact row projection, before journal ack.
            await publish(record)
            await verifyServiceSkill(root, owned)
        },
        async remove(root, owned, outerGuard) {
            const value = await guard()
            if (root !== value.authority.skillsRoot) throw new Error('Service skill root changed')
            const record = (await store.list(value.owner)).find(row => row.skills.some(resource => sameResource(resource, owned)))
            if (!record) throw new Error('Service skill projection unavailable')
            const reservation = (await services.skillJournal.list(value.owner)).find(row => row.installationId === record.id && row.resource && sameResource(row.resource, owned))
            if (!reservation) throw new Error('Service skill reservation unavailable')
            await removeReserved(record, reservation, outerGuard)
        },
        async referencedInstallations(owner, slug, exceptId) {
            const value = await guard()
            if (owner !== value.owner) throw new Error('Service skill owner changed')
            return (await store.list(owner)).filter(row => row.id !== exceptId && row.skills.some(skill => skill.slug === slug)).length
        },
    }
    const decorateInstalls = (installs: AccountInstallPort): AccountInstallPort => {
        const health = async (record: AccountInstallRecord) => {
            if (record.health.state === 'healthy') {
                try { await services.skillAuthority.assertReady(record.owner, record.id, context.getStore()?.signal) }
                catch { return { ...record, health: { state: 'unchecked' as const }, healthLaunch: null, toolNames: [] } }
            }
            return record
        }
        return {
            ...installs,
            list: async owner => Promise.all((await installs.list(owner)).map(health)),
            read: async (owner, key) => { const record = await installs.read(owner, key); return record ? health(record) : null },
            async create(record, bearer) { await guard(); await installs.create(record, bearer); await publish(record) },
            async update(record, revision, bearer) {
                await guard()
                await installs.update(record, revision, bearer)
                // Removal intentionally keeps its old projected resources for recovery.
                if (record.state !== 'removing') await publish(record)
                else { const value = await guard(); await services.syncRegistry(value.authority.skillsRoot, value.owner, value.signal) }
            },
            async remove(record) {
                const current = await byId(record.id)
                for (const reservation of (await services.skillJournal.list(record.owner)).filter(row => row.installationId === record.id)) await removeReserved(current, reservation, async () => { await guard(current) })
                const reservations = await services.skillJournal.list(record.owner)
                if (current.skills.some(owned => !reservations.some(row => row.installationId === current.id && row.state === 'removed' && row.resource && sameResource(row.resource, owned)))) throw new Error('Service skill removal ownership unavailable')
                await guard(current); await installs.remove(record)
                const value = await guard(); await services.syncRegistry(value.authority.skillsRoot, value.owner, value.signal)
            },
        }
    }
    const secrets = legacyCompatibleHeaderSecrets(store, sqliteHeaderSecrets(store.db, keyReader))
    const transport = canonicalAccountTransport(services, secrets)
    services.setAccountTransport(transport)
    const feature = await openDesktopServiceAccounts(runtime, {
        keyReader, skills, decorateInstalls, assertToolNames: services.assertToolNames,
        authority: { async current(owner, action, signal) { const value = await services.current(owner, action, undefined, signal); return { engineAgentId: value.engineAgentId, enabled: value.enabled, granted: value.granted, skillsRoot: value.skillsRoot, launchNonce: value.runtime.launchNonce } } },
        transport: {
            async probe(input) {
                const value = await guard(), request = probeContext.getStore()
                if (!request || request.owner !== value.owner) throw new Error('Service probe identity unavailable')
                const record = await services.liveRecord(value.owner, request.key, request.revision, input.signal)
                if (record.plan.url !== input.url) throw new Error('Service endpoint changed')
                await input.guard?.()
                const result = await services.transport(record, undefined, input.signal).probe(record.owner, services.idName(record), record.revision, input.signal)
                await input.guard?.()
                if (!result.tools) throw new Error('Service discovery unavailable')
                return { tools: result.tools }
            },
            async call() { throw new Error('Service tool calls require the authenticated chat bridge') },
        },
    })
    const probeContext = new AsyncLocalStorage<{ owner: string; key: string; revision: string }>()
    const attempts = accountAttempts(store)
    const mounted: AccountFeature = {
        ...feature,
        async handle(request, owner) {
            if (request.method === 'POST') {
                const raw = await request.clone().text()
                if (raw.length <= 32768) {
                    let body: unknown
                    try { body = JSON.parse(raw) } catch { /* Existing handler reports invalid input. */ }
                    if (body && typeof body === 'object' && 'action' in body && (body.action === 'prepare-attempt' || body.action === 'acknowledge-attempt')) {
                        try {
                            const signal = AbortSignal.any([request.signal, AbortSignal.timeout(20_000)])
                            const result = await services.accountMutation(owner, true, async () => {
                                await services.current(owner, 'manage', undefined, signal)
                                const result = await attempts(owner, body)
                                await services.current(owner, 'manage', undefined, signal)
                                return result
                            })
                            return Response.json(result, { headers: { 'cache-control': 'no-store' } })
                        } catch { return Response.json({ error: 'Account attempt unavailable or acknowledgement unknown. Refresh and retry this attempt.' }, { status: 400, headers: { 'cache-control': 'no-store' } }) }
                    }
                }
            }
            return feature.handle.call(mounted, request, owner)
        },
        async mutate(owner, body, signal) {
            const input = desktopServiceAccountMutationSchema.parse(body)
            return services.accountMutation(owner, input.action === 'probe', async () => {
                const authority = await services.current(owner, 'manage', undefined, signal)
                return context.run({ owner, signal, authority }, async () => {
                    const execute = () => feature.mutate(owner, input, signal)
                    const result = input.action === 'probe' && input.intent.kind === 'existing'
                        ? await probeContext.run({ owner, key: input.intent.accountKey, revision: input.intent.expectedRevision }, execute)
                        : await execute()
                    await guard()
                    await services.syncRegistry(authority.skillsRoot, owner, signal)
                    return result
                })
            })
        },
    }
    return mounted
}
