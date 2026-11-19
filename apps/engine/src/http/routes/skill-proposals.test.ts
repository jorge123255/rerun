import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-proposal-routes-'))
process.env.RERUN_API_KEY = ''

const applied: string[] = []
vi.mock('../../skills/apply-proposal.js', () => ({
    applySkillProposal: async (_agent: unknown, row: { id: string }) => {
        applied.push(row.id)
    },
}))

const { describe, expect, it, beforeAll } = await import('vitest')
const { mkdir } = await import('node:fs/promises')
const { createServer } = await import('../server.js')
const { agentConfigSchema } = await import('../../agents/types.js')
const { writeAgentConfig } = await import('../../agents/config-write.js')
const { agentDir } = await import('../../config/paths.js')
const { insertSkillProposal, getSkillProposal } = await import('../../db/repos/skill-proposals.js')

const id = 'routeagent'
const app = createServer()

let seq = 0
async function proposal() {
    seq += 1
    return insertSkillProposal(id, {
        sessionId: 'session-1',
        runId: null,
        toolCallId: `call-${seq}`,
        mode: 'create',
        slug: null,
        title: 'Publishing checklist',
        summary: 'Always end a post with a CTA',
        instruction: 'Every post ends with a call to action.',
        fingerprint: `fp-${seq}`,
    })
}

beforeAll(async () => {
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: 'route agent' }))
})

describe('skill proposal routes', () => {
    it('lists the proposals of one conversation', async () => {
        const row = await proposal()
        const res = await app.request(`/agents/${id}/skill-proposals?session=session-1`)
        expect(res.status).toBe(200)
        const { proposals } = (await res.json()) as { proposals: { id: string; instructions: string[] }[] }
        expect(proposals.some(p => p.id === row.id)).toBe(true)
        expect(proposals[0].instructions).toEqual(['Every post ends with a call to action.'])
    })

    it('answers the accept before the writing is done', async () => {
        const row = await proposal()
        const res = await app.request(`/agents/${id}/skill-proposals/${row.id}/accept`, { method: 'POST' })
        expect(res.status).toBe(202)
        expect((await getSkillProposal(id, row.id))?.status).toBe('accepted')
        expect(applied).toContain(row.id)
    })

    it('runs the job once however many times the row is clicked', async () => {
        const row = await proposal()
        await app.request(`/agents/${id}/skill-proposals/${row.id}/accept`, { method: 'POST' })
        const second = await app.request(`/agents/${id}/skill-proposals/${row.id}/accept`, { method: 'POST' })
        expect(second.status).toBe(200)
        expect(applied.filter(pid => pid === row.id)).toHaveLength(1)
    })

    it('dismisses without touching the job', async () => {
        const row = await proposal()
        const res = await app.request(`/agents/${id}/skill-proposals/${row.id}/dismiss`, { method: 'POST' })
        expect(res.status).toBe(200)
        expect((await getSkillProposal(id, row.id))?.status).toBe('dismissed')
        expect(applied).not.toContain(row.id)
    })
})

it('binds Chief decisions to the exact open conversation and revision the person reviewed', async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    try {
        const { ensureForeman } = await import('../../agents/foreman.js')
        const { createSession } = await import('../../db/repos/sessions.js')
        const { appendSkillProposalInstruction } = await import('../../db/repos/skill-proposals.js')
        await ensureForeman()
        const mine = await createSession('foreman')
        const sibling = await createSession('foreman')
        const child = await createSession('foreman', 'not personal', {originAgentId:'other', originSessionId:'another'})
        const row = await insertSkillProposal('foreman', {sessionId: mine.id, runId:'run-1',toolCallId:'tool-1',
            mode:'create',slug:null,title:'Daily notes',summary:'Short notes',instruction:'Summarize in five words.',fingerprint:'chief-fp'})
        const url = '/agents/foreman/skill-proposals'
        const listing = async (session: string) => app.request(url + '?session=' + session)
        const decide = (session:string, revision:string) => app.request(url + '/' + row.id + '/dismiss?session=' + session,
            {method:'POST',headers:{'If-Match':'"'+revision+'"'}})
        const { proposals } = await (await listing(mine.id)).json() as {proposals: {id:string, revision:string}[]}
        const first = proposals.find(p=>p.id===row.id)!
        expect(first.revision).toMatch(/^[0-9a-f]{64}$/)
        expect(await (await listing('new-chat')).json()).toEqual({proposals:[]})
        expect((await listing(child.id)).status).toBe(404)
        expect((await decide(sibling.id,first.revision)).status).toBe(404)
        await appendSkillProposalInstruction('foreman',row.id,{summary:'Updated rule',instruction:'Use numbered notes.',fingerprint:'updated'})
        expect((await decide(mine.id,first.revision)).status).toBe(409)
        expect((await getSkillProposal('foreman',row.id))?.status).toBe('proposed')
        const fresh = await (await listing(mine.id)).json() as {proposals:{revision:string}[]}
        expect((await decide(mine.id,fresh.proposals[0].revision)).status).toBe(200)
        expect((await getSkillProposal('foreman',row.id))?.status).toBe('dismissed')
    } finally { vi.unstubAllEnvs() }
})
