import 'server-only'

import { parseServiceRegistryKey } from '@rerun/contracts'
import { createHmac } from 'node:crypto'
import type { DesktopServiceHealth } from '@rerun/contracts'
import type { ServiceStore, ServiceInstall, OwnedSkill } from '../store'
import type { AccountCompilePlan } from './compiler'

export type AccountInstallState = 'preparing' | 'ready' | 'error' | 'disconnected' | 'removing'

export type AccountInstallRecord = {
    owner: string
    engineId: string
    key: string
    id: string
    revision: string
    state: AccountInstallState
    plan: AccountCompilePlan
    skills: OwnedSkill[]
    toolNames: string[]
    health: DesktopServiceHealth
    healthLaunch: string | null
    installedAt: string
}

export interface AccountInstallPort {
    list(owner: string): Promise<AccountInstallRecord[]>
    read(owner: string, key: string): Promise<AccountInstallRecord | null>
    create(record: AccountInstallRecord, bearer: string): Promise<void>
    update(record: AccountInstallRecord, expectedRevision: string, bearer?: string): Promise<void>
    remove(record: AccountInstallRecord): Promise<void>
    digest(owner: string, value: unknown): string
}

export function accountDigest(key: Buffer, owner: string, value: unknown): string {
    return createHmac('sha256', key).update(JSON.stringify([owner, canonical(value)])).digest('hex')
}

export function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]))
    }
    return value
}

function asAccount(record: ServiceInstall): AccountInstallRecord {
    const plan = record.plan as Partial<AccountCompilePlan> & ServiceInstall['plan']
    if (plan.shape !== undefined) {
        if (!['anonymous', 'bearer', 'headers'].includes(plan.shape) || !Array.isArray(plan.credentialInputs) || !Array.isArray(plan.headerPlan) || !plan.publicInputs || typeof plan.label !== 'string') throw new Error('Invalid service account plan')
        return { ...record, plan: plan as AccountCompilePlan }
    }
    const { instanceId } = parseServiceRegistryKey(record.key)
    return { ...record, plan: {
        ...record.plan, label: record.plan.name, ...(instanceId ? { instanceId } : {}),
        shape: record.plan.secretInput ? 'bearer' : 'anonymous',
        credentialInputs: record.plan.secretInput ? [record.plan.secretInput] : [], publicInputs: {},
        headerPlan: record.plan.secretInput ? [{ name: 'Authorization', source: 'input', inputKeys: [record.plan.secretInput], secret: true }] : [],
    } }
}

function asService(record: AccountInstallRecord, bearer: string): ServiceInstall {
    return { ...record, plan: record.plan, configured: bearer.length > 0 }
}

/** Uses the canonical service table. Header values stay out of `plan`. */
export function serviceStoreInstalls(store: ServiceStore): AccountInstallPort {
    return {
        list: async owner => (await store.list(owner)).map(asAccount),
        read: async (owner, key) => {
            const row = await store.read(owner, key)
            return row ? asAccount(row) : null
        },
        create: (record, bearer) => store.create(asService(record, bearer), bearer),
        update: (record, expectedRevision, bearer) => store.update(bearer === undefined ? asService(record, '') : asService(record, bearer), expectedRevision, bearer),
        remove: async record => {
            await store.remove(asService(record, ''))
        },
        digest: (owner, value) => store.digest(owner, canonical(value)),
    }
}

export function memoryInstalls(key = Buffer.alloc(32, 7)): AccountInstallPort {
    const rows: AccountInstallRecord[] = []
    return {
        async list(owner) {
            const mine = rows.filter(row => row.owner === owner)
            if (mine.length > 64) throw new Error('Too many service installations')
            return mine.map(row => ({ ...row, plan: { ...row.plan }, skills: [...row.skills], toolNames: [...row.toolNames] }))
        },
        async read(owner, accountKey) {
            const row = rows.find(item => item.owner === owner && item.key === accountKey)
            return row ? { ...row, plan: { ...row.plan }, skills: [...row.skills], toolNames: [...row.toolNames] } : null
        },
        async create(record, _bearer) {
            if (rows.some(row => row.owner === record.owner && row.key === record.key)) throw new Error('Service revision conflict')
            if (rows.filter(row => row.owner === record.owner).length >= 64) throw new Error('Too many service installs')
            rows.push({ ...record, plan: { ...record.plan }, skills: [...record.skills], toolNames: [...record.toolNames] })
        },
        async update(record, expectedRevision, _bearer) {
            const index = rows.findIndex(row => row.owner === record.owner && row.key === record.key && row.id === record.id && row.revision === expectedRevision)
            if (index < 0) throw new Error('Service revision conflict')
            rows[index] = { ...record, plan: { ...record.plan }, skills: [...record.skills], toolNames: [...record.toolNames] }
        },
        async remove(record) {
            const index = rows.findIndex(row => row.owner === record.owner && row.key === record.key && row.id === record.id && row.revision === record.revision)
            if (index < 0) throw new Error('Service revision conflict')
            rows.splice(index, 1)
        },
        digest: (owner, value) => accountDigest(key, owner, value),
    }
}
