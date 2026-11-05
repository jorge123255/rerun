import { describe, expect, it } from 'vitest'
import { issueIsolatedViewerTicket, redeemIsolatedViewerTicket, revokeIsolatedViewerTickets, ISOLATED_VIEWER_TICKET_TTL_MS, type IsolatedScreenOwner, type IsolatedScreenTarget } from './isolated-viewer.js'

const owner: IsolatedScreenOwner = { engineAgentId: 'agent-1', launchNonce: 'nonce-1' }
const target: IsolatedScreenTarget = { ...owner, sessionGeneration: 'gen-1' }

function issue(mode: 'watch' | 'drive' = 'watch', at = Date.now()) {
    return issueIsolatedViewerTicket({ owner, target, mode }, at)
}

describe('isolated viewer tickets', () => {
    it('redeems a fresh ticket exactly once', () => {
        const { ticket } = issue()
        const first = redeemIsolatedViewerTicket(ticket)
        expect(first?.mode).toBe('watch')
        expect(first?.target).toEqual(target)
        expect(redeemIsolatedViewerTicket(ticket)).toBeNull()
    })

    it('rejects expired and unknown tickets', () => {
        const { ticket } = issue('drive', Date.now() - ISOLATED_VIEWER_TICKET_TTL_MS - 1)
        expect(redeemIsolatedViewerTicket(ticket)).toBeNull()
        expect(redeemIsolatedViewerTicket('nope')).toBeNull()
    })

    it('keeps the strict mode on the ticket', () => {
        const { ticket } = issue('drive')
        expect(redeemIsolatedViewerTicket(ticket)?.mode).toBe('drive')
    })

    it('revokes every ticket of one owner without touching another', () => {
        const mine = issue()
        const otherOwner: IsolatedScreenOwner = { engineAgentId: 'agent-2', launchNonce: 'nonce-1' }
        const other = issueIsolatedViewerTicket({ owner: otherOwner, target: { ...otherOwner, sessionGeneration: 'gen-9' }, mode: 'watch' })
        revokeIsolatedViewerTickets(owner)
        expect(redeemIsolatedViewerTicket(mine.ticket)).toBeNull()
        expect(redeemIsolatedViewerTicket(other.ticket)?.owner.engineAgentId).toBe('agent-2')
    })
})
