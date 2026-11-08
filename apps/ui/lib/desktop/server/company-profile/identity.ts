import { createHash } from 'node:crypto'
import {
    desktopCompanyProfileCanonical,
    industryHint,
    type DesktopCompanyProfileCanonicalContext,
    type DesktopCompanyProfileIdentity,
    type DesktopForemanIntakeAnswers,
    type DesktopForemanIntakeSession,
} from '@rerun/contracts'
import { DesktopCompanyProfileError } from './errors'

export function desktopCompanyProfileInput(session: DesktopForemanIntakeSession, kind: 'decide' | 'enrich', accepted?: DesktopForemanIntakeAnswers | null): string | null {
    if (kind === 'decide') return industryHint(session.draft)
    if (session.draft.websiteSkipped) return null
    return session.draft.companyUrl.trim() || accepted?.companyUrl?.trim() || null
}

export function desktopCompanyProfileInputDigest(kind: 'decide' | 'enrich', input: string): string {
    return createHash('sha256').update(desktopCompanyProfileCanonical(['desktop-company-profile-input-v1', kind, input.trim()])).digest('hex')
}

export function desktopCompanyProfileIdentities(session: DesktopForemanIntakeSession, accepted?: DesktopForemanIntakeAnswers | null): {
    decision: DesktopCompanyProfileIdentity | null
    enrichment: DesktopCompanyProfileIdentity | null
} {
    const identity = (kind: 'decide' | 'enrich') => {
        const input = desktopCompanyProfileInput(session, kind, accepted)
        return input ? { chat: session.chat, draftRevision: session.revision, inputDigest: desktopCompanyProfileInputDigest(kind, input) } : null
    }
    return { decision: identity('decide'), enrichment: identity('enrich') }
}

export function assertDesktopCompanyProfileIdentity(
    context: DesktopCompanyProfileCanonicalContext,
    identity: DesktopCompanyProfileIdentity,
    kind: 'decide' | 'enrich',
): void {
    const current = desktopCompanyProfileIdentities(context.session, context.accepted)[kind === 'decide' ? 'decision' : 'enrichment']
    if (context.session.chat.workspaceId !== identity.chat.workspaceId || context.session.chat.chatId !== identity.chat.chatId
        || !current || current.draftRevision !== identity.draftRevision || current.inputDigest !== identity.inputDigest) {
        throw new DesktopCompanyProfileError('stale', 'These company details changed. Review the current question before trying again.')
    }
}

export function desktopCompanyProfileFingerprint(kind: 'decide' | 'enrich', identity: DesktopCompanyProfileIdentity, collect = false): string {
    return createHash('sha256').update(desktopCompanyProfileCanonical(['desktop-company-profile-request-v1', kind, identity, kind === 'enrich' ? collect : null])).digest('hex')
}

export function desktopCompanyProfileAttemptFingerprint(attempt: unknown): string {
    return createHash('sha256').update(desktopCompanyProfileCanonical(['desktop-company-profile-attempt-v1', attempt])).digest('hex')
}

export function desktopCompanyProfileRequestId(kind: 'decide' | 'enrich', identity: DesktopCompanyProfileIdentity): string {
    const hex = createHash('sha256').update(desktopCompanyProfileFingerprint(kind, identity)).digest('hex').slice(0, 32).split('')
    hex[12] = '4'
    hex[16] = '89ab'[Number.parseInt(hex[16], 16) % 4]
    const value = hex.join('')
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
