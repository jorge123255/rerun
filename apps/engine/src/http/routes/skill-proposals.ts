import { createHash } from 'node:crypto'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { Hono, type Context } from 'hono'
import { getSession } from '../../db/repos/sessions.js'
import type { SkillProposalRow } from '../../db/schema.js'
import { desktopApp } from '../../desktop/policy.js'
import { getAgent } from '../../agents/registry.js'
import { applySkillProposal } from '../../skills/apply-proposal.js'
import { getSkillProposal, listSessionSkillProposals, toSkillProposal, transitionSkillProposal } from '../../db/repos/skill-proposals.js'
import { badRequest, HttpError, notFound } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'

export const skillProposalRoutes = new Hono()

const isDesktopChief = (agentId: string) => agentId === FOREMAN_AGENT_ID && desktopApp()

function present(agentId: string, row: SkillProposalRow) {
    const result = toSkillProposal(row)
    if (!isDesktopChief(agentId)) return result
    const revision = createHash('sha256').update(JSON.stringify(result)).digest('hex')
    return { ...result, revision }
}

async function chiefSession(c: Context, agentId: string) {
    const sessionId = c.req.query('session')
    if (!sessionId) throw badRequest('session is required')
    const session = await getSession(agentId, sessionId)
    if (session && (session.agentId !== agentId || session.source !== 'dashboard' || session.status !== 'open' ||
        session.originAgentId || session.originSessionId)) throw notFound('conversation')
    return session
}

async function reviewedChiefProposal(c: Context, agentId: string, id: string) {
    if (!isDesktopChief(agentId)) return undefined
    const session = await chiefSession(c, agentId)
    const row = await getSkillProposal(agentId, id)
    if (!session || !row || row.agentId !== agentId || row.sessionId !== session.id) throw notFound('proposal')
    const shown = present(agentId, row)
    if (!('revision' in shown) || c.req.header('If-Match') !== `"${shown.revision}"`) {
        throw new HttpError(409, 'This proposal changed. Review it again.')
    }
    return row
}

skillProposalRoutes.get('/', async c => {
    const agentId = c.req.param('id')!
    const sessionId = c.req.query('session')
    if (!sessionId) return c.json({ error: 'session is required' }, 400)
    if (isDesktopChief(agentId) && !await chiefSession(c, agentId)) return c.json({ proposals: [] })
    const rows = await listSessionSkillProposals(agentId, sessionId)
    return c.json({ proposals: rows.filter(row => row.agentId === agentId).map(row => present(agentId, row)) })
})

// Accepting answers before the writing is done: the job holds no session claim, opens no run and
// appends no message, so nothing about it reaches the conversation.
skillProposalRoutes.post('/:pid/accept', async c => {
    const agentId = c.req.param('id')!
    const pid = c.req.param('pid')!
    const reviewed = await reviewedChiefProposal(c, agentId, pid)
    const claimed = await transitionSkillProposal(agentId, pid, ['proposed', 'failed'], 'accepted', { error: null }, reviewed)
    if (!claimed && reviewed) throw new HttpError(409, 'This proposal changed. Review it again.')
    const row = await getSkillProposal(agentId, pid)
    if (!row) throw notFound('proposal')
    if (!claimed) return c.json({ proposal: present(agentId,row) }, 200)

    const agent = await getAgent(agentId)
    void applySkillProposal(agent, row).catch(err => logger.warn({ err: String(err), agent: agentId, proposal: pid }, 'skill proposal job crashed'))
    return c.json({ proposal: present(agentId,{ ...row, status: 'accepted' }) }, 202)
})

skillProposalRoutes.post('/:pid/dismiss', async c => {
    const agentId = c.req.param('id')!
    const pid = c.req.param('pid')!
    const reviewed = await reviewedChiefProposal(c, agentId, pid)
    const changed = await transitionSkillProposal(agentId, pid, ['proposed', 'failed'], 'dismissed', {}, reviewed)
    if (!changed && reviewed) throw new HttpError(409, 'This proposal changed. Review it again.')
    const row = await getSkillProposal(agentId, pid)
    if (!row) throw notFound('proposal')
    return c.json({ proposal: present(agentId,row) })
})
