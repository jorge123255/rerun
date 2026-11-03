import { sanitizeIdentifier } from '@/lib/utils'

export function allocateHandle(displayName: string, taken: Set<string>): string {
    const base = sanitizeIdentifier(displayName).replace(/^_+|_+$/g, '') || 'agent'
    let candidate = base
    for (let i = 2; taken.has(candidate); i++) candidate = `${base}_${i}`
    return candidate
}
