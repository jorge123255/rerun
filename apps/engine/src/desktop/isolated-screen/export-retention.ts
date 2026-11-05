import { PAGE_RETENTION } from './export-metadata.js'

export type BrowserExportRetentionRecord = {
    operationKey: string; digest: string; ownerId: string; createdAt: string
    byteLength: number; unchanged: boolean; active: boolean
}

export function planBrowserExportRetention(ownerId: string, records: readonly BrowserExportRetentionRecord[], nowMs: number) {
    if (!ownerId || records.length > 4096 || !Number.isFinite(nowMs)) throw new Error('Invalid browser retention inventory.')
    const seen = new Set<string>()
    const owned = records.filter(record => record.ownerId === ownerId).map(record => {
        if (!record.operationKey || seen.has(record.operationKey) || !/^[a-f0-9]{64}$/.test(record.digest)
            || !Number.isSafeInteger(record.byteLength) || record.byteLength < 0 || !Number.isFinite(Date.parse(record.createdAt))
            || typeof record.unchanged !== 'boolean' || typeof record.active !== 'boolean') throw new Error('Invalid browser retention record.')
        seen.add(record.operationKey)
        return { ...record, time: Date.parse(record.createdAt) }
    }).sort((left, right) => left.time - right.time || left.operationKey.localeCompare(right.operationKey))
    let retainedBytes = owned.reduce((sum, record) => sum + record.byteLength, 0)
    if (!Number.isSafeInteger(retainedBytes)) throw new Error('Invalid browser retention total.')
    const candidates: Array<{ operationKey: string; digest: string }> = []
    for (const record of owned) {
        if (record.active || !record.unchanged || record.time > nowMs) continue
        if (nowMs - record.time <= PAGE_RETENTION.maxAgeMs && retainedBytes <= PAGE_RETENTION.maxOwnedBytes) continue
        candidates.push({ operationKey: record.operationKey, digest: record.digest })
        retainedBytes -= record.byteLength
    }
    return { candidates, retainedBytes, overBudget: retainedBytes > PAGE_RETENTION.maxOwnedBytes }
}
