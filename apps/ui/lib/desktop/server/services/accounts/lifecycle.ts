import 'server-only'

import { parseServiceRegistryKey } from '@rerun/contracts'
import type { DesktopServiceHealth } from '@rerun/contracts'
import type { AuthMethod, ServiceManifest } from '@/lib/services/manifest'
import type { OwnedSkill } from '../store'
import {
    DESKTOP_SERVICE_ACCOUNT_MESSAGES as M,
    type DesktopServiceAccountBinding,
    type DesktopServiceAccountMutation,
    type DesktopServiceAccountResult,
    type DesktopServiceAccountView,
} from '@rerun/contracts'
import { accountMethodAvailability } from './availability'
import { compileAccountService, type AccountCompilePlan } from './compiler'
import { accountKeyFor, isDisplayMask, nextAccountLabel, takenInstanceIds } from './identity'
import { DESKTOP_SERVICE_ACCOUNT_LIMIT } from '@rerun/contracts'
import { canonical, type AccountInstallPort, type AccountInstallRecord } from './installs'
import type { AccountReservation, ReservationPhase, ReservationPort } from './reservations'
import { type HeaderSecretPort } from './secret-store'
import { bundlesMatch, type HeaderSecretBundle } from './header-secret-codec'
import type { AccountTransportPort } from './transport'

export interface AccountAuthority {
    engineAgentId: string
    enabled: boolean
    granted: boolean
    skillsRoot: string
    launchNonce: string
}

export interface AccountAuthorityPort {
    current(coworkerId: string, action: 'manage' | 'use', signal: AbortSignal): Promise<AccountAuthority>
}

export interface AccountCatalogPort {
    manifest(slug: string): Promise<ServiceManifest | null>
}

export interface AccountSkillPort {
    create(root: string, installationId: string, index: number, skill: AccountCompilePlan['skills'][number], guard: () => Promise<void>): Promise<OwnedSkill>
    verify(root: string, owned: OwnedSkill): Promise<void>
    remove(root: string, owned: OwnedSkill, guard: () => Promise<void>): Promise<void>
    referencedInstallations(owner: string, skillSlug: string, exceptInstallationId: string): Promise<number>
}

export interface AccountIdPort {
    uuid(): string
    instanceId(taken: ReadonlySet<string>): string
}

export type AccountToolGuard = (owner: string, installationId: string, names: string[], signal: AbortSignal) => Promise<void>

export type AccountLifecycleDeps = {
    installs: AccountInstallPort
    secrets: HeaderSecretPort
    reservations: ReservationPort
    catalog: AccountCatalogPort
    authority: AccountAuthorityPort
    transport: AccountTransportPort
    ids: AccountIdPort
    clock: { now(): string }
    skills?: AccountSkillPort
    assertToolNames?: AccountToolGuard
}

type Flight = { fingerprint: string; promise: Promise<DesktopServiceAccountResult> }

function wipe(bundle: HeaderSecretBundle | null) {
    if (!bundle) return
    for (const record of [bundle.headers, bundle.inputs]) for (const key of Object.keys(record)) record[key] = ''
}

export function defaultToolGuard(installs: AccountInstallPort): AccountToolGuard {
    return async (owner, installationId, names) => {
        const prefixes = (await installs.list(owner)).filter(row => row.id !== installationId && row.state !== 'disconnected').map(row => row.plan.serverName)
        if (new Set(names).size !== names.length || names.some(name => !/^[\w.-]{1,128}$/.test(name) || prefixes.some(prefix => name.startsWith(`${prefix}_`)))) throw new Error(M.toolName)
    }
}

export function accountLifecycle(deps: AccountLifecycleDeps) {
    const active = new Map<string, Flight>()
    const tails = new Map<string, Promise<unknown>>()
    const exclusive = <T>(owner: string, run: () => Promise<T>): Promise<T> => {
        const previous = tails.get(owner) ?? Promise.resolve()
        const next = previous.then(run, run)
        tails.set(owner, next.then(() => undefined, () => undefined))
        return next
    }
    const authorityOf = async (binding: DesktopServiceAccountBinding, action: 'manage' | 'use', signal: AbortSignal) => {
        signal.throwIfAborted()
        const authority = await deps.authority.current(binding.coworkerId, action, signal)
        signal.throwIfAborted()
        if (authority.engineAgentId !== binding.engineOwnerId) throw new Error(M.owner)
        return authority
    }
    const referenced = async (owner: string, skillSlug: string, exceptId: string) => {
        const local = (await deps.installs.list(owner)).filter(row => row.id !== exceptId && row.skills.some(skill => skill.slug === skillSlug)).length
        return local + (deps.skills ? await deps.skills.referencedInstallations(owner, skillSlug, exceptId) : 0)
    }
    const present = (record: AccountInstallRecord, authority: AccountAuthority, configured: boolean): DesktopServiceAccountView => {
        const sameEngine = authority.engineAgentId === record.engineId
        const checkedAt = Date.parse(record.health.checkedAt ?? '')
        const fresh = record.health.state === 'healthy' && record.healthLaunch === authority.launchNonce && Number.isFinite(checkedAt) && Date.parse(deps.clock.now()) - checkedAt < 60_000
        const healthy = sameEngine && record.state === 'ready' && authority.enabled && authority.granted && fresh
        const health: DesktopServiceHealth = !sameEngine
            ? { state: 'unchecked', message: M.owner }
            : healthy
              ? record.health
              : record.state === 'disconnected'
                ? { state: 'disconnected', message: M.removed }
                : !authority.enabled || !authority.granted
                  ? { state: 'unchecked', message: M.grant }
                  : record.health.state === 'error'
                    ? record.health
                    : { state: 'unchecked', message: 'Connection health is not established for the current permissions and app launch.' }
        return {
            key: record.key,
            slug: record.plan.slug,
            ...(record.plan.instanceId ? { instanceId: record.plan.instanceId } : {}),
            label: record.plan.label,
            name: record.plan.name,
            icon: record.plan.icon,
            category: record.plan.category,
            status: healthy ? 'active' : record.state === 'error' ? 'error' : 'needs_config',
            toolNames: healthy ? record.toolNames : [],
            authMethodId: record.plan.methodId,
            installedAt: record.installedAt,
            revision: record.revision,
            health,
            installationId: record.id,
            shape: record.plan.shape,
            headerPlan: record.plan.headerPlan,
            configured: record.plan.shape === 'anonymous' || configured,
            configuredInputs: Object.fromEntries(record.plan.credentialInputs.filter(() => configured).map(key => [key, true as const])),
            publicInputs: record.plan.publicInputs,
        }
    }
    const view = async (record: AccountInstallRecord, binding: DesktopServiceAccountBinding, signal: AbortSignal) => present(record, await authorityOf(binding, 'manage', signal), record.plan.shape === 'anonymous' || (await deps.secrets.has(record.owner, record.id)))
    const replay = async (binding: DesktopServiceAccountBinding, reservation: AccountReservation, signal: AbortSignal): Promise<DesktopServiceAccountResult> => {
        const result = reservation.publicResult
        if (!result?.accountKey) return result ?? { status: 'unknown', message: M.unknown }
        const now = await deps.installs.read(binding.coworkerId, result.accountKey)
        if (!now) return result.status === 'removed' ? result : { status: 'unknown', accountKey: result.accountKey, message: M.gone }
        if (result.revision && now.revision !== result.revision) return { status: 'unknown', accountKey: result.accountKey, message: M.stale }
        return { ...result, account: await view(now, binding, signal) }
    }
    const save = async (reservation: AccountReservation, expected: ReservationPhase, next: Partial<AccountReservation>) => {
        const updated = { ...reservation, ...next }
        await deps.reservations.save(updated, expected)
        return updated
    }
    const methodOf = (manifest: ServiceManifest, methodId: string): AuthMethod => {
        const method = manifest.authMethods.find(item => item.id === methodId)
        if (!method || !accountMethodAvailability(manifest, methodId).supported) throw new Error(method ? M.method : M.unknownMethod)
        return method
    }
    const resolveValues = (method: AuthMethod, submitted: Record<string, string>, previous: HeaderSecretBundle | null, allowBlankSecrets: boolean) => {
        const values = { ...submitted }
        for (const input of method.inputs) {
            const value = values[input.key] ?? ''
            if (isDisplayMask(value)) throw new Error(M.mask)
            if (input.secret && value.trim() === '' && allowBlankSecrets && previous?.inputs[input.key]) values[input.key] = previous.inputs[input.key]
        }
        return values
    }
    const assertClear = (plan: AccountCompilePlan, bundle: HeaderSecretBundle) => {
        const encoded = JSON.stringify(plan)
        for (const value of [...Object.values(bundle.inputs), ...plan.headerPlan.filter(entry => entry.secret).map(entry => bundle.headers[entry.name] ?? '')]) {
            if (value.length >= 8 && encoded.includes(value)) throw new Error(M.leak)
        }
    }
    const room = async (owner: string, requestId: string) => {
        const installs = await deps.installs.list(owner)
        const keys = new Set(installs.map(row => row.key))
        for (const reservation of await deps.reservations.list(owner)) {
            if (reservation.requestId !== requestId && reservation.accountKey && reservation.phase !== 'complete') keys.add(reservation.accountKey)
        }
        if (keys.size >= DESKTOP_SERVICE_ACCOUNT_LIMIT) throw new Error(M.limit)
        return installs
    }
    const allocate = async (binding: DesktopServiceAccountBinding, reservation: AccountReservation, manifest: ServiceManifest, kind: 'new' | 'additional') => {
        const installs = await room(binding.coworkerId, reservation.requestId)
        const base = installs.find(row => row.key === manifest.slug)
        if (kind === 'new') {
            if (base) throw new Error(M.baseExists)
            return { reservation: await save(reservation, reservation.phase, { phase: 'allocated', accountKey: manifest.slug, installationId: deps.ids.uuid(), revision: deps.ids.uuid() }), label: manifest.name, instanceId: undefined as string | undefined }
        }
        if (!base) throw new Error(M.needBase)
        if (!manifest.multiInstance) throw new Error(M.notMulti)
        const tombstones = await deps.reservations.tombstones(binding.coworkerId)
        const reserved = (await deps.reservations.list(binding.coworkerId)).flatMap(row => (row.accountKey && row.requestId !== reservation.requestId ? [row.accountKey] : []))
        const taken = takenInstanceIds(manifest.slug, [...installs.map(row => row.key), ...tombstones, ...reserved])
        const instanceId = deps.ids.instanceId(taken)
        const accountKey = accountKeyFor(manifest.slug, instanceId)
        if (taken.has(instanceId) || accountKey === manifest.slug || tombstones.includes(accountKey) || installs.some(row => row.key === accountKey)) throw new Error(M.instance)
        return { reservation: await save(reservation, reservation.phase, { phase: 'allocated', accountKey, installationId: deps.ids.uuid(), revision: deps.ids.uuid() }), label: nextAccountLabel(manifest.name, installs.filter(row => row.plan.slug === manifest.slug).map(row => row.plan.label)), instanceId }
    }
    const sealAndPublish = async (binding: DesktopServiceAccountBinding, reservation: AccountReservation, manifest: ServiceManifest, methodId: string, values: Record<string, string>, label: string, instanceId: string | undefined, signal: AbortSignal) => {
        const authority = await authorityOf(binding, 'manage', signal)
        const compiled = compileAccountService(manifest, methodId, values, { id: methodId, supported: true }, { label, instanceId })
        if (compiled.plan.key !== reservation.accountKey || !reservation.installationId || !reservation.revision) throw new Error(M.instance)
        compiled.plan.label = label
        const bundle = { headers: { ...compiled.headers }, inputs: Object.fromEntries(compiled.plan.credentialInputs.map(key => [key, values[key] ?? ''])) }
        assertClear(compiled.plan, bundle)
        try {
            const owner = binding.coworkerId
            const existing = await deps.installs.read(owner, reservation.accountKey)
            if (existing && (existing.id !== reservation.installationId || existing.engineId !== binding.engineOwnerId)) throw new Error(M.owner)
            if (existing && existing.skills.length > 0 && JSON.stringify(existing.plan.skills) !== JSON.stringify(compiled.plan.skills)) throw new Error(M.skill)
            if (compiled.plan.skills.length > 0 && !deps.skills) throw new Error(M.skillsUnavailable)
            if (compiled.plan.shape === 'anonymous') {
                if (await deps.secrets.has(owner, reservation.installationId)) {
                    const atNew = await deps.secrets.read(owner, reservation.installationId, reservation.revision)
                    const atOld = existing && existing.revision !== reservation.revision ? await deps.secrets.read(owner, reservation.installationId, existing.revision) : null
                    if (atNew) await deps.secrets.remove(owner, reservation.installationId, reservation.revision)
                    else if (atOld && existing) await deps.secrets.remove(owner, reservation.installationId, existing.revision)
                    else throw new Error(M.secretConflict)
                }
            } else {
                const stored = await deps.secrets.read(owner, reservation.installationId, reservation.revision)
                if (stored) {
                    if (!bundlesMatch(stored, bundle)) throw new Error(M.secretConflict)
                } else {
                    const previousRevision = existing && existing.revision !== reservation.revision ? existing.revision : null
                    const previousBundle = previousRevision ? await deps.secrets.read(owner, reservation.installationId, previousRevision) : null
                    await deps.secrets.write({ owner, installationId: reservation.installationId, expectedRevision: previousBundle ? previousRevision : null, revision: reservation.revision, bundle })
                }
            }
            const record: AccountInstallRecord = {
                owner,
                engineId: authority.engineAgentId,
                key: reservation.accountKey,
                id: reservation.installationId,
                revision: reservation.revision,
                state: existing?.state === 'ready' ? 'ready' : 'preparing',
                plan: compiled.plan,
                skills: existing?.skills ?? [],
                toolNames: [],
                health: { state: 'unchecked' },
                healthLaunch: null,
                installedAt: existing?.installedAt ?? deps.clock.now(),
            }
            if (!existing) await deps.installs.create(record, compiled.bearer)
            else if (existing.revision !== record.revision) await deps.installs.update(record, existing.revision, compiled.bearer)
            let current = reservation.phase === 'reserved' || reservation.phase === 'allocated' ? await save(reservation, reservation.phase, { phase: 'sealed' }) : reservation
            if (deps.skills && compiled.plan.skills.length) {
                const guard = async () => {
                    const now = await authorityOf(binding, 'manage', signal)
                    if (now.skillsRoot !== authority.skillsRoot || now.launchNonce !== authority.launchNonce) throw new Error(M.owner)
                }
                for (const skill of record.skills) await deps.skills.verify(authority.skillsRoot, skill)
                for (let index = record.skills.length; index < compiled.plan.skills.length; index += 1) {
                    record.skills.push(await deps.skills.create(authority.skillsRoot, record.id, index, compiled.plan.skills[index], guard))
                    await deps.installs.update(record, record.revision)
                }
            }
            await authorityOf(binding, 'manage', signal)
            if (record.state !== 'ready') {
                record.state = 'ready'
                await deps.installs.update(record, record.revision)
            }
            if (current.phase === 'sealed') current = await save(current, 'sealed', { phase: 'published' })
            return current
        } finally {
            wipe(bundle)
            for (const key of Object.keys(compiled.headers)) compiled.headers[key] = ''
        }
    }
    const configure = async (binding: DesktopServiceAccountBinding, reservation: AccountReservation, input: Extract<DesktopServiceAccountMutation, { action: 'install' | 'reconfigure' }>, signal: AbortSignal) => {
        const manifestSlug = input.intent.kind === 'existing' ? parseServiceRegistryKey(input.intent.accountKey).slug : input.intent.slug
        const manifest = await deps.catalog.manifest(manifestSlug)
        if (!manifest || manifest.slug !== manifestSlug || manifestSlug.includes('@')) throw new Error(M.unknownService)
        const method = methodOf(manifest, input.authMethodId)
        const existing = input.intent.kind === 'existing' ? await deps.installs.read(binding.coworkerId, input.intent.accountKey) : reservation.accountKey ? await deps.installs.read(binding.coworkerId, reservation.accountKey) : null
        if (input.intent.kind === 'existing') {
            if (!existing || (existing.revision !== input.intent.expectedRevision && existing.revision !== reservation.revision)) throw new Error(M.revision)
            if (existing.engineId !== binding.engineOwnerId) throw new Error(M.owner)
            if (existing.state === 'removing') throw new Error(M.revision)
        }
        const previous = existing ? (await deps.secrets.read(binding.coworkerId, existing.id, existing.revision)) ?? (reservation.revision ? await deps.secrets.read(binding.coworkerId, existing.id, reservation.revision) : null) : null
        const values = resolveValues(method, input.values, previous, input.intent.kind === 'existing')
        let target = reservation
        let label = existing?.plan.label ?? manifest.name
        let instanceId = existing?.plan.instanceId
        if (input.intent.kind === 'existing' && existing && !target.installationId) {
            target = await save(target, target.phase, { phase: 'allocated', accountKey: existing.key, installationId: existing.id, revision: deps.ids.uuid() })
            label = existing.plan.label
            instanceId = existing.plan.instanceId
        }
        if (!target.accountKey) {
            const preview = compileAccountService(manifest, input.authMethodId, values, { id: input.authMethodId, supported: true }, { label: manifest.name, ...(input.intent.kind === 'additional' ? { instanceId: 'aaaaaa' } : {}) })
            wipe({ headers: preview.headers, inputs: {} })
            const allocated = await allocate(binding, target, manifest, input.intent.kind === 'additional' ? 'additional' : 'new')
            target = allocated.reservation
            label = allocated.label
            instanceId = allocated.instanceId
        } else if (!existing) {
            const parsed = parseServiceRegistryKey(target.accountKey)
            instanceId = parsed.instanceId
            const labels = (await deps.installs.list(binding.coworkerId)).filter(row => row.plan.slug === manifest.slug).map(row => row.plan.label)
            label = parsed.instanceId ? nextAccountLabel(manifest.name, labels) : manifest.name
        }
        target = await sealAndPublish(binding, target, manifest, input.authMethodId, values, label, instanceId, signal)
        const saved = await deps.installs.read(binding.coworkerId, target.accountKey!)
        if (!saved) throw new Error(M.revision)
        const result: DesktopServiceAccountResult = { status: 'needs_config', accountKey: saved.key, installationId: saved.id, revision: saved.revision, message: 'Configuration saved. Tool permission stays off until you enable Apps.', account: await view(saved, binding, signal) }
        await save(target, target.phase, { phase: 'complete', publicResult: { ...result, account: undefined } })
        return result
    }
    const dropSkills = async (binding: DesktopServiceAccountBinding, record: AccountInstallRecord, signal: AbortSignal) => {
        if (!record.skills.length) return
        if (!deps.skills) throw new Error(M.skillsUnavailable)
        const guard = async () => {
            await authorityOf(binding, 'manage', signal)
        }
        for (const skill of record.skills) {
            if ((await referenced(binding.coworkerId, skill.slug, record.id)) === 0) await deps.skills.remove((await authorityOf(binding, 'manage', signal)).skillsRoot, skill, guard)
        }
    }
    const disconnectOrRemove = async (binding: DesktopServiceAccountBinding, reservation: AccountReservation, action: 'disconnect' | 'remove', expectedRevision: string, signal: AbortSignal) => {
        if (!reservation.accountKey) throw new Error(M.revision)
        const accountKey = reservation.accountKey
        let record = await deps.installs.read(binding.coworkerId, accountKey)
        if (record && record.engineId !== binding.engineOwnerId) throw new Error(M.owner)
        if (!record && action === 'disconnect') return { status: 'unknown' as const, accountKey: accountKey, message: M.gone }
        if (record && record.revision !== expectedRevision && record.revision !== reservation.revision) throw new Error(M.revision)
        if (reservation.phase === 'reserved') {
            if (record && record.revision !== expectedRevision) throw new Error(M.revision)
            reservation = await save(reservation, 'reserved', { phase: 'mutating', revision: deps.ids.uuid() })
        }
        if (!reservation.revision) throw new Error(M.revision)
        if (record && record.revision !== reservation.revision) {
            if (record.revision !== expectedRevision) throw new Error(M.revision)
            await authorityOf(binding, 'manage', signal)
            await deps.secrets.remove(binding.coworkerId, record.id, record.revision)
            const next: AccountInstallRecord = { ...record, revision: reservation.revision, state: action === 'remove' ? 'removing' : 'disconnected', health: { state: 'disconnected', message: M.removed }, healthLaunch: null, toolNames: [] }
            await deps.installs.update(next, record.revision, '')
            record = next
        }
        if (action === 'remove') {
            if (record) await dropSkills(binding, record, signal)
            await deps.reservations.tombstone(binding.coworkerId, accountKey, deps.clock.now())
            if (record) await deps.installs.remove(record)
        }
        await authorityOf(binding, 'manage', signal)
        const after = await deps.installs.read(binding.coworkerId, accountKey)
        const result: DesktopServiceAccountResult = action === 'remove' || !after
            ? { status: 'removed', accountKey: accountKey, installationId: record?.id, revision: reservation.revision, message: M.removed }
            : { status: 'disconnected', accountKey: after.key, installationId: after.id, revision: after.revision, message: M.removed, account: await view(after, binding, signal) }
        await save(reservation, reservation.phase, { phase: 'complete', publicResult: { ...result, account: undefined } })
        return result
    }
    const probe = async (binding: DesktopServiceAccountBinding, reservation: AccountReservation, signal: AbortSignal): Promise<DesktopServiceAccountResult> => {
        if (reservation.phase === 'probing') return { status: 'unknown' as const, accountKey: reservation.accountKey ?? undefined, message: M.unknown }
        if (!reservation.accountKey || !reservation.revision) throw new Error(M.revision)
        const record = await deps.installs.read(binding.coworkerId, reservation.accountKey)
        if (!record || record.revision !== reservation.revision) throw new Error(M.revision)
        if (record.engineId !== binding.engineOwnerId) throw new Error(M.owner)
        const authority = await authorityOf(binding, 'manage', signal)
        if (!authority.enabled || !authority.granted) {
            reservation = await save(reservation, 'reserved', { phase: 'probing' })
            record.toolNames = []
            record.health = { state: 'unchecked', message: M.grant }
            record.healthLaunch = null
            await deps.installs.update(record, record.revision)
            const saved = await deps.installs.read(binding.coworkerId, record.key)
            if (!saved) throw new Error(M.gone)
            const result: DesktopServiceAccountResult = { status: 'probed', accountKey: saved.key, installationId: saved.id, revision: saved.revision, message: M.grant, account: await view(saved, binding, signal) }
            await save(reservation, 'probing', { phase: 'complete', publicResult: { ...result, account: undefined } })
            return result
        }
        const useAuthority = await authorityOf(binding, 'use', signal)
        if (useAuthority.engineAgentId !== record.engineId) throw new Error(M.owner)
        const bundle: HeaderSecretBundle | null = record.plan.shape === 'anonymous' ? { headers: {}, inputs: {} } : await deps.secrets.read(binding.coworkerId, record.id, record.revision)
        if (!bundle) throw new Error(M.credential)
        reservation = await save(reservation, 'reserved', { phase: 'probing' })
        let aborted = false
        try {
            if (deps.skills) for (const skill of record.skills) await deps.skills.verify(useAuthority.skillsRoot, skill)
            const guard = async () => {
                const current = await deps.installs.read(binding.coworkerId, record.key)
                const latest = await authorityOf(binding, 'use', signal)
                if (!latest.enabled || !latest.granted) throw new Error(M.grant)
                if (latest.launchNonce !== useAuthority.launchNonce || latest.engineAgentId !== record.engineId) throw new Error(M.owner)
                if (!current || current.id !== record.id || current.revision !== record.revision || current.state !== 'ready' || current.plan.url !== record.plan.url) throw new Error(M.revision)
            }
            await guard()
            const discovered = await deps.transport.probe({ url: record.plan.url, headers: bundle.headers, secretValues: Object.values(bundle.inputs), guard, signal })
            const names = discovered.tools.map(tool => `${record.plan.serverName}_${tool.name}`)
            await (deps.assertToolNames ?? defaultToolGuard(deps.installs))(binding.coworkerId, record.id, names, signal)
            await guard()
            record.toolNames = names
            record.health = { state: 'healthy', checkedAt: deps.clock.now(), toolCount: names.length }
            record.healthLaunch = useAuthority.launchNonce
            await deps.installs.update(record, record.revision)
        } catch {
            if (signal.aborted) {
                aborted = true
            } else {
                record.toolNames = []
                record.health = { state: 'error', checkedAt: deps.clock.now(), message: M.probeFailed }
                record.healthLaunch = null
                await deps.installs.update(record, record.revision).catch(() => {})
            }
        } finally {
            wipe(bundle)
        }
        if (aborted) return { status: 'unknown' as const, accountKey: reservation.accountKey ?? undefined, message: M.cancelled }
        const now = await deps.installs.read(binding.coworkerId, record.key)
        if (!now) throw new Error(M.gone)
        const result: DesktopServiceAccountResult = { status: 'probed', accountKey: now.key, installationId: now.id, revision: now.revision, message: now.health.message, account: await view(now, binding, signal) }
        await save(reservation, 'probing', { phase: 'complete', publicResult: { ...result, account: undefined } })
        return result
    }
    const run = async (binding: DesktopServiceAccountBinding, input: DesktopServiceAccountMutation, fingerprint: string, signal: AbortSignal) => {
        let reservation = await deps.reservations.begin(binding.coworkerId, input.requestId, fingerprint, deps.clock.now())
        if (reservation.phase === 'complete') return replay(binding, reservation, signal)
        if (input.action === 'probe' && reservation.phase === 'probing') return { status: 'unknown' as const, accountKey: reservation.accountKey ?? undefined, message: M.unknown }
        if (input.action !== 'install' && input.intent.kind === 'existing' && !reservation.accountKey) {
            reservation = await save(reservation, reservation.phase, { accountKey: input.intent.accountKey, revision: input.intent.expectedRevision })
        }
        await authorityOf(binding, 'manage', signal)
        if (input.action === 'install' || input.action === 'reconfigure') return configure(binding, reservation, input, signal)
        if (input.action === 'probe') return probe(binding, reservation, signal)
        return disconnectOrRemove(binding, reservation, input.action, input.intent.expectedRevision, signal)
    }
    return {
        view,
        present,
        async list(binding: DesktopServiceAccountBinding, signal: AbortSignal) {
            await authorityOf(binding, 'manage', signal)
            return Promise.all((await deps.installs.list(binding.coworkerId)).map(row => view(row, binding, signal)))
        },
        mutate(binding: DesktopServiceAccountBinding, input: DesktopServiceAccountMutation, signal: AbortSignal) {
            const fingerprint = deps.installs.digest(binding.coworkerId, canonical(input))
            const flightKey = `${binding.coworkerId}\0${input.requestId}`
            const current = active.get(flightKey)
            if (current) {
                if (current.fingerprint !== fingerprint) throw new Error(M.reused)
                return current.promise
            }
            const promise = exclusive(binding.coworkerId, () => run(binding, input, fingerprint, signal))
            active.set(flightKey, { fingerprint, promise })
            const cleanup = () => {
                if (active.get(flightKey)?.promise === promise) active.delete(flightKey)
            }
            void promise.then(cleanup, cleanup)
            return promise
        },
        async callTool(binding: DesktopServiceAccountBinding, accountKey: string, revision: string, call: { name: string; arguments: Record<string, unknown> }, signal: AbortSignal) {
            const record = await deps.installs.read(binding.coworkerId, accountKey)
            if (!record || record.revision !== revision || record.state !== 'ready' || record.engineId !== binding.engineOwnerId) throw new Error(M.revision)
            const authority = await authorityOf(binding, 'use', signal)
            if (authority.engineAgentId !== record.engineId) throw new Error(M.owner)
            if (!authority.enabled || !authority.granted) throw new Error(M.grant)
            const checkedAt = Date.parse(record.health.checkedAt ?? '')
            const fresh = record.health.state === 'healthy' && record.healthLaunch === authority.launchNonce && Number.isFinite(checkedAt) && Date.parse(deps.clock.now()) - checkedAt < 60_000
            if (!fresh || !record.toolNames.includes(`${record.plan.serverName}_${call.name}`)) throw new Error(M.probeFailed)
            const bundle = record.plan.shape === 'anonymous' ? { headers: {}, inputs: {} } : await deps.secrets.read(binding.coworkerId, record.id, record.revision)
            if (!bundle) throw new Error(M.credential)
            const guard = async () => {
                const current = await deps.installs.read(binding.coworkerId, accountKey)
                const latest = await authorityOf(binding, 'use', signal)
                if (!latest.enabled || !latest.granted) throw new Error(M.grant)
                if (latest.launchNonce !== authority.launchNonce || latest.engineAgentId !== record.engineId) throw new Error(M.owner)
                if (!current || current.id !== record.id || current.revision !== revision || current.state !== 'ready'
                    || current.plan.url !== record.plan.url || !current.toolNames.includes(`${record.plan.serverName}_${call.name}`)) throw new Error(M.revision)
            }
            try {
                if (deps.skills) for (const skill of record.skills) await deps.skills.verify(authority.skillsRoot, skill)
                await guard()
                const result = await deps.transport.call({ url: record.plan.url, headers: bundle.headers, secretValues: Object.values(bundle.inputs), guard, signal, ...call })
                await guard()
                return result
            } finally {
                wipe(bundle)
            }
        },
    }
}

export type AccountLifecycle = ReturnType<typeof accountLifecycle>
