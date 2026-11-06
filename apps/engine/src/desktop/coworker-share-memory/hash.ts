import { createHash } from 'node:crypto'

export const sha256Hex = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
        entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
    }
    return JSON.stringify(value) ?? 'null'
}
