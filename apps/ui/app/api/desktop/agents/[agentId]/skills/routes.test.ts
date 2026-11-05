import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { GET as getSkill, PATCH as patchSkill } from './[slug]/route'
import { GET as getProposals } from './proposals/route'
import { POST as decideProposal } from './proposals/[proposalId]/route'

const service = vi.hoisted(() => ({
    getCoworkerSkill: vi.fn(), updateCoworkerSkill: vi.fn(), deleteCoworkerSkill: vi.fn(),
    listCoworkerSkillProposals: vi.fn(), decideCoworkerSkillProposal: vi.fn(),
}))
vi.mock('@/lib/desktop/server/coworker-skills', () => service)
const originalEnv = { ...process.env }
let root: string, runtime: DesktopRuntime
const skillContext = { params: Promise.resolve({ agentId: 'local-owner', slug: 'example' }) }
const proposalContext = { params: Promise.resolve({ agentId: 'local-owner', proposalId: 'proposal-one' }) }
function request(path: string, method = 'GET', body?: unknown, authenticated = true) {
    const headers = new Headers({ host: new URL(runtime.app.origin).host, origin: runtime.app.origin, 'content-type': 'application/json' })
    if (authenticated) headers.set('cookie', `rerun-desktop-session=${runtime.app.sessionToken}`)
    return new Request(runtime.app.origin + path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) })
}
beforeEach(async () => {
    vi.resetAllMocks()
    root = await mkdtemp(join(tmpdir(), 'rerun-skill-routes-'))
    runtime = { protocolVersion: 1, launchNonce: 'skills-routes', buildId: 'fixture', workspaceId: 1, dataRoot: root,
        app: { origin: 'http://127.0.0.1:3198', sessionToken: 's'.repeat(48) }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused-fixture' } }
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
})
afterEach(async () => { process.env = { ...originalEnv }; await rm(root, { recursive: true, force: true }) })

test('authenticated manifest GET preserves the confined version and PATCH requires and forwards it', async () => {
    const skill = { slug: 'example', name: 'Example', description: '', body: 'Old', files: [], identity: '1:2:3:4:5:6:1:complete' }
    service.getCoworkerSkill.mockResolvedValue(skill)
    expect(await (await getSkill(request('/skill'), skillContext)).json()).toEqual({ skill })
    expect((await patchSkill(request('/skill', 'PATCH', { body: 'New' }), skillContext)).status).toBe(400)
    expect(service.updateCoworkerSkill).not.toHaveBeenCalled()
    service.updateCoworkerSkill.mockResolvedValue({ success: false, status: 409, error: 'Changed elsewhere' })
    expect((await patchSkill(request('/skill', 'PATCH', { body: 'New', baseIdentity: skill.identity }), skillContext)).status).toBe(409)
    expect(service.updateCoworkerSkill).toHaveBeenCalledWith(expect.anything(), 'local-owner', 'example', { body: 'New', baseIdentity: skill.identity })
})

test('proposal routes pass only the validated local chat scope and preserve decision refusal status', async () => {
    service.listCoworkerSkillProposals.mockResolvedValue({ availability: 'complete', proposals: [] })
    const context = { params: Promise.resolve({ agentId: 'local-owner' }) }
    expect((await getProposals(request('/proposals?sessionId=local-chat'), context)).status).toBe(200)
    expect(service.listCoworkerSkillProposals).toHaveBeenCalledWith(expect.anything(), 'local-owner', 'local-chat')
    expect((await getProposals(request('/proposals?sessionId=one&sessionId=two'), context)).status).toBe(400)
    expect(service.listCoworkerSkillProposals).toHaveBeenCalledTimes(1)
    service.decideCoworkerSkillProposal.mockResolvedValue({ success: false, status: 404, error: 'Chat does not own this proposal' })
    expect((await decideProposal(request('/proposal', 'POST', { decision: 'accept', sessionId: 'local-chat' }), proposalContext)).status).toBe(404)
    expect(service.decideCoworkerSkillProposal).toHaveBeenCalledWith(expect.anything(), 'local-owner', 'proposal-one', 'accept', 'local-chat')
    expect((await decideProposal(request('/proposal', 'POST', { decision: 'accept', sessionId: 'local-chat', agentId: 'forged' }), proposalContext)).status).toBe(400)
    expect(service.decideCoworkerSkillProposal).toHaveBeenCalledTimes(1)
})

test('oversize and unauthenticated proposal decisions cannot reach the mutation', async () => {
    expect((await decideProposal(request('/proposal', 'POST', { decision: 'accept', sessionId: 'x'.repeat(5000) }), proposalContext)).status).toBe(413)
    expect((await decideProposal(request('/proposal', 'POST', { decision: 'accept' }, false), proposalContext)).status).toBe(401)
    expect(service.decideCoworkerSkillProposal).not.toHaveBeenCalled()
})
