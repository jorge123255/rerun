import { parseServiceRegistryKey, serviceRegistryKey } from '@rerun/contracts'
import { DESKTOP_SERVICE_ACCOUNT_LIMIT, DESKTOP_SERVICE_ACCOUNT_MESSAGES as M } from '../../../../../../../packages/contracts/src/desktop-service-accounts'

const MASK = /^[•*·.]+$/

export function isDisplayMask(value: string): boolean {
    return value.length > 0 && MASK.test(value)
}

/** "App 2", "App 3" — the same ordinal rule as `ordinalInstanceLabel`. A label is not an id. */
export function nextAccountLabel(serviceName: string, labels: Iterable<string>): string {
    const used = new Set(labels)
    let n = 2
    while (used.has(`${serviceName} ${n}`)) n += 1
    return `${serviceName} ${n}`
}

export function takenInstanceIds(slug: string, keys: Iterable<string>): Set<string> {
    const taken = new Set<string>()
    for (const key of keys) {
        const parsed = parseServiceRegistryKey(key)
        if (parsed.slug === slug && parsed.instanceId) taken.add(parsed.instanceId)
    }
    return taken
}

export function assertAccountRoom(count: number) {
    if (count >= DESKTOP_SERVICE_ACCOUNT_LIMIT) throw new Error(M.limit)
}

export function accountKeyFor(slug: string, instanceId?: string): string {
    return serviceRegistryKey(slug, instanceId)
}
