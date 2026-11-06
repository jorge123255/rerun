import { resolveShareInclude } from '@rerun/contracts'
import {
    shareAuditSchema,
    shareCandidateSchema,
    shareGrantSchema,
    type ShareAudit,
    type ShareCandidate,
    type ShareGrant,
} from './contract.js'

const BLOCKED_PREFIXES = ['memory/', 'workspace/.rerun/', '.rerun/']
const BLOCKED_PATHS = new Set(['data/agent.db', 'workspace/.rerun/services.json'])

export type ShareProjection = {
    outcome: 'refused' | 'empty' | 'projected' | 'expired' | 'revoked'
    items: ShareCandidate[]
    audit: ShareAudit
}

function audit(partial: Omit<ShareAudit, 'itemIds'> & { itemIds?: string[] }): ShareAudit {
    return shareAuditSchema.parse({ ...partial, itemIds: partial.itemIds ?? [] })
}

export function shareSelectionIsExplicit(input: unknown): boolean {
    const include = resolveShareInclude(input)
    return include.memories === false && include.database === false
}

export function createPublicSharePolicy() {
    return {
        issue(grant: ShareGrant, enabled: boolean): { grant: ShareGrant | null; audit: ShareAudit } {
            if (enabled !== true) return { grant: null, audit: audit({ grantId: null, action: 'issue', outcome: 'refused' }) }
            const parsed = shareGrantSchema.safeParse(grant)
            if (!parsed.success || parsed.data.revoked) return { grant: null, audit: audit({ grantId: null, action: 'issue', outcome: 'refused' }) }
            return { grant: parsed.data, audit: audit({ grantId: parsed.data.grantId, action: 'issue', outcome: 'issued' }) }
        },
        revoke(grant: ShareGrant): { grant: ShareGrant; audit: ShareAudit } {
            const next = shareGrantSchema.parse({ ...grant, revoked: true })
            return { grant: next, audit: audit({ grantId: next.grantId, action: 'revoke', outcome: 'revoked' }) }
        },
        project(input: {
            enabled: boolean
            callerId: string
            proofId: string
            grant: ShareGrant | null
            items: ShareCandidate[]
            now: string
        }): ShareProjection {
            if (input.enabled !== true || input.callerId !== input.proofId) {
                return { outcome: 'refused', items: [], audit: audit({ grantId: input.grant?.grantId ?? null, action: 'project', outcome: 'refused' }) }
            }
            const grant = input.grant ? shareGrantSchema.safeParse(input.grant) : null
            if (!grant?.success || grant.data.subjectId !== input.callerId || grant.data.revoked) {
                const outcome = grant?.success && grant.data.revoked ? 'revoked' : 'refused'
                return { outcome, items: [], audit: audit({ grantId: grant?.success ? grant.data.grantId : null, action: 'project', outcome }) }
            }
            if (Date.parse(input.now) >= Date.parse(grant.data.expiresAt)) {
                return { outcome: 'expired', items: [], audit: audit({ grantId: grant.data.grantId, action: 'project', outcome: 'expired' }) }
            }
            const allowed = new Set(grant.data.itemIds)
            const items: ShareCandidate[] = []
            for (const raw of input.items) {
                const item = shareCandidateSchema.safeParse(raw)
                if (!item.success || !allowed.has(item.data.id)) continue
                if (BLOCKED_PATHS.has(item.data.path) || BLOCKED_PREFIXES.some(prefix => item.data.path.startsWith(prefix))) continue
                items.push(item.data)
            }
            return {
                outcome: items.length ? 'projected' : 'empty',
                items,
                audit: audit({ grantId: grant.data.grantId, action: 'project', outcome: items.length ? 'projected' : 'empty', itemIds: items.map(item => item.id) }),
            }
        },
    }
}
