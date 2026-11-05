import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { TEXT_FILE_PAGE_CHARS } from '@rerun/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareSkillHelperFixture } from '../../../../engine/src/desktop/skill-publication.test-support'
import * as skillStore from './coworker-skill-store'
import * as engineClient from '@/lib/engine/client'
import { setSkillPublishHooksForTests } from '../../../../engine/src/desktop/skill-publication'
import { closeDesktopDatabase, openDesktopDatabase } from './database'
import { createDesktopAgent, createDesktopSession, listDesktopAgents } from './store'
import {
    createCoworkerSkill,
    getCoworkerSkill,
    decideCoworkerSkillProposal,
    deleteCoworkerSkill,
    deleteCoworkerSkillFile,
    listCoworkerSkillProposals,
    listCoworkerSkills,
    readCoworkerSkillFile,
    skillSlugOf,
    updateCoworkerSkill,
    writeCoworkerSkillFile,
} from './coworker-skills'
import type { DesktopRuntime } from './runtime'

const originalHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
beforeAll(async () => { helper = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path })
afterAll(async () => {
    if (originalHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER
    else process.env.RERUN_DESKTOP_RENAME_HELPER = originalHelper
    await helper?.close()
})

type FakeSkill = { slug: string; name: string; description: string; body: string; files: string[] }

async function bodyOf(req: IncomingMessage) {
    let text = ''
    for await (const chunk of req) text += chunk
    return text ? JSON.parse(text) : null
}

function json(res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))
}

function fakeSkill(slug: string): FakeSkill {
    return { slug, name: slug, description: `About ${slug}`, body: `# ${slug}\n\nDo the thing.`, files: [] }
}

// Full engine proposal rows: the client parses them with engineSkillProposalSchema, which requires
// every field below, so the fake has to answer with all of them or the parse fails.
type FakeProposal = {
    id: string
    sessionId: string
    toolCallId: string
    mode: 'create' | 'edit'
    slug: string | null
    title: string
    summary: string
    instructions: string[]
    status: 'proposed' | 'accepted' | 'applied' | 'failed' | 'dismissed'
    appliedSlug: string | null
    error: string | null
    createdAt: string
}

function fakeProposal(id: string, overrides: Partial<FakeProposal> = {}): FakeProposal {
    return {
        id,
        sessionId: 'engine-session-1',
        toolCallId: `tc-${id}`,
        mode: 'create',
        slug: null,
        title: 'Keep a rule',
        summary: 'Keep the review rules',
        instructions: [],
        status: 'proposed',
        appliedSlug: null,
        error: null,
        createdAt: '2026-11-04T00:00:00.000Z',
        ...overrides,
    }
}

describe('desktop coworker skills server', () => {
    let server: Server
    let root: string
    let runtime: DesktopRuntime
    let agentId: string
    let localSessionId: string
    let skills: Map<string, FakeSkill>
    let registry: { services: Record<string, { skills: string[]; status: string; config: Record<string, string>; installedAt: string }> }
    let imported: Array<{ content: string; files: unknown; name?: string; description?: string; overwrite?: boolean }>
    let proposals: FakeProposal[]
    // The per-agent services registry can be made to fail (unreachable engine) or to claim a slug
    // on the read that happens after the roster lock is taken.
    let registryError: Error | null
    let registryBody: string | null
    let ownedOnSecondRead: string[]
    let registryReads: number
    let failProposalSessions: Set<string>
    let proposalOverrides: Map<string, FakeProposal[]>
    let proposalReads: string[]
    let decisions: string[]
    const skillFolder = (slug: string) => join(root, 'workspaces', '1', 'engine', 'agents', 'engine-agent-1', 'skills', slug)
    const registryFile = () => join(root, 'workspaces', '1', 'engine', 'agents', 'engine-agent-1', 'workspace', '.rerun', 'services.json')
    const writeRegistry = async (value: unknown = registry) => { await mkdir(dirname(registryFile()), { recursive: true }); await writeFile(registryFile(), JSON.stringify(value)) }


    beforeEach(async () => {
        skills = new Map()
        registry = { services: {} }
        imported = []
        proposals = []
        registryError = null
        registryBody = null
        ownedOnSecondRead = []
        registryReads = 0
        failProposalSessions = new Set()
        proposalOverrides = new Map(); proposalReads = []; decisions = []
        root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-desktop-skills-')))
        await writeRegistry()
        server = createServer(async (req, res) => {
            const body = await bodyOf(req)
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')

            // Skills shelf.
            if (req.method === 'GET' && url.pathname === '/agents/engine-agent-1/skills') {
                return json(res, { skills: [...skills.values()] })
            }
            if (req.method === 'POST' && url.pathname === '/agents/engine-agent-1/skills/import') {
                imported.push(body)
                const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
                const existed = skills.has(slug)
                if (existed && !body.overwrite) return json(res, { error: `A skill named "${body.name ?? slug}" already exists` }, 409)
                const skill = fakeSkill(slug)
                skills.set(slug, skill)
                return json(res, { ...skill }, existed ? 200 : 201)
            }
            if (url.pathname.startsWith('/agents/engine-agent-1/skills/') && req.method === 'GET') {
                const slug = url.pathname.split('/').at(-1)
                const skill = slug ? skills.get(slug) : undefined
                if (!skill) return json(res, { error: 'skill not found' }, 404)
                return json(res, { ...skill })
            }
            if (url.pathname.startsWith('/agents/engine-agent-1/skills/') && req.method === 'PATCH') {
                const slug = url.pathname.split('/').at(-1)
                const skill = slug ? skills.get(slug) : undefined
                if (!skill) return json(res, { error: 'skill not found' }, 404)
                skills.set(skill.slug, { ...skill, ...(body?.description !== undefined && { description: body.description }), ...(body?.body !== undefined && { body: body.body }) })
                return json(res, { ...skills.get(skill.slug)! })
            }
            if (url.pathname.startsWith('/agents/engine-agent-1/skills/') && req.method === 'DELETE') {
                const slug = url.pathname.split('/').at(-1)
                if (slug && skills.has(slug)) skills.delete(slug)
                res.writeHead(204).end()
                return
            }

            // Agent config, read only: the desktop no longer patches it on skill writes.
            if (req.method === 'GET' && url.pathname === '/agents/engine-agent-1') return json(res, { id: 'engine-agent-1', config: { tools: { skills: true }, selfImprovement: { enabled: true } }, soul: '' })

            // The per-agent services registry that decides connector ownership. Mutation admission
            // is fail-closed, so an unreachable engine must read as an error, not an empty registry.
            if (url.pathname === '/agents/engine-agent-1/files/read' && url.searchParams.get('path') === '.rerun/services.json') {
                registryReads += 1
                if (registryError) return json(res, { error: registryError.message }, 500)
                if (registryBody !== null) return json(res, { content: registryBody, truncated: false })
                if (registryReads > 1 && ownedOnSecondRead.length > 0) {
                    return json(res, { content: JSON.stringify({ services: { 'demo-app': { status: 'active', config: {}, skills: ownedOnSecondRead, installedAt: '2026-01-01T00:00:00.000Z' } } }), truncated: false })
                }
                return json(res, { content: JSON.stringify(registry), truncated: false })
            }

            // Skill proposals.
            if (url.pathname === '/agents/engine-agent-1/skill-proposals' && req.method === 'GET') {
                const sessionId = url.searchParams.get('session')
                proposalReads.push(sessionId ?? '')
                if (sessionId && failProposalSessions.has(sessionId)) return json(res, { error: 'session unavailable' }, 500)
                return json(res, { proposals: proposalOverrides.get(sessionId ?? '') ?? proposals.filter(p => p.sessionId === sessionId) })
            }
            if (url.pathname.startsWith('/agents/engine-agent-1/skill-proposals/') && req.method === 'POST') {
                const [pid, decision] = url.pathname.split('/').slice(-2)
                decisions.push(`${pid}:${decision}`)
                const proposal = proposals.find(p => p.id === pid)
                if (!proposal) return json(res, { error: 'proposal not found' }, 404)
                proposals = proposals.map(p => p.id === pid ? { ...p, status: decision === 'accept' ? 'accepted' : 'dismissed' } : p)
                return json(res, { proposal: proposals.find(p => p.id === pid) }, 202)
            }

            return json(res, { error: 'not found' }, 404)
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing test engine address')
        runtime = {
            protocolVersion: 1,
            launchNonce: 'skills-launch',
            buildId: 'skills-build',
            workspaceId: 1,
            dataRoot: root,
            app: { origin: 'http://127.0.0.1:3100', sessionToken: 's'.repeat(48) },
            engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'engine-secret' },
        }
        const db = await openDesktopDatabase(root)
        await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Coworker' })
        const agents = await listDesktopAgents(db)
        agentId = agents[0]!.id
        localSessionId = (await createDesktopSession(db, { agentId, engineSessionId: 'engine-session-1', title: 'First' })).id
        await closeDesktopDatabase(root)
    })

    afterEach(async () => {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        vi.restoreAllMocks()
        await closeDesktopDatabase(root)
        await rm(root, { recursive: true, force: true })
    })

    it('mirrors engine slugify, so ownership checks address the same slug the engine derives', () => {
        expect(skillSlugOf('Web Research!')).toBe('web-research')
        expect(skillSlugOf('  Q&A — Billing  ')).toBe('q-a-billing')
        expect(skillSlugOf('a'.repeat(120))).toHaveLength(64)
    })

    it('flags connector-owned skills as read-only in the shelf', async () => {
        skills.set('from-app', fakeSkill('from-app'))
        registry = {
            services: {
                'demo-app': { status: 'active', config: {}, skills: ['from-app'], installedAt: '2026-01-01T00:00:00.000Z' },
            },
        }
        await writeRegistry()
        await mkdir(skillFolder('from-app'), { recursive: true })
        await writeFile(join(skillFolder('from-app'), 'SKILL.md'), '---\nname: from-app\ndescription: App procedure\n---\n\nDo this.\n')
        const shelf = await listCoworkerSkills(runtime, agentId)
        expect(shelf.find(s => s.slug === 'from-app')?.fromConnector).toBe(true)
    })

    it('creates a skill on disk without calling the engine import', async () => {
        const result = await createCoworkerSkill(runtime, agentId, { name: 'Web Research', description: 'Find sources', body: '# body' })
        expect(result.success).toBe(true)
        expect(result.skill?.slug).toBe('web-research')
        expect(imported).toHaveLength(0)
        const manifest = await readFile(join(skillFolder('web-research'), 'SKILL.md'), 'utf8')
        expect(manifest).toContain('# body')
        expect(manifest).toContain('Find sources')
    })

    it('refuses to create a skill whose slug a connector owns, even when the engine would accept it', async () => {
        registry = {
            services: {
                'demo-app': { status: 'active', config: {}, skills: ['owned-by-app'], installedAt: '2026-01-01T00:00:00.000Z' },
            },
        }
        await writeRegistry()
        const result = await createCoworkerSkill(runtime, agentId, { name: 'Owned By App', description: '', body: '# body' })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/belongs to the demo-app app/)
        expect(imported).toHaveLength(0)
    })

    it('refuses to create a skill when the slug already exists (no silent overwrite)', async () => {
        await mkdir(skillFolder('existing'), { recursive: true })
        const original = '---\nname: "existing"\ndescription: "About existing"\n---\n\n# Existing\n\nDo the thing.\n'
        await writeFile(join(skillFolder('existing'), 'SKILL.md'), original, 'utf8')
        const result = await createCoworkerSkill(runtime, agentId, { name: 'Existing', description: '', body: '# body' })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/already exists/)
        expect(imported).toHaveLength(0)
        expect(await readFile(join(skillFolder('existing'), 'SKILL.md'), 'utf8')).toBe(original)
    })

    it('refuses update, delete and file writes on connector-owned skills at the desktop server', async () => {
        registry = {
            services: {
                'demo-app': { status: 'active', config: {}, skills: ['connector'], installedAt: '2026-01-01T00:00:00.000Z' },
            },
        }
        const original = '---\nname: "connector"\ndescription: "About connector"\n---\n\n# connector\n\nDo the thing.\n'
        await mkdir(skillFolder('connector'), { recursive: true })
        await writeFile(join(skillFolder('connector'), 'SKILL.md'), original, 'utf8')
        await writeRegistry()
        const update = await updateCoworkerSkill(runtime, agentId, 'connector', { body: '# changed', baseIdentity: (await getCoworkerSkill(runtime, agentId, 'connector'))!.identity! })
        expect(update).toEqual({ success: false, error: expect.stringMatching(/belongs to the demo-app app/) })
        const remove = await deleteCoworkerSkill(runtime, agentId, 'connector')
        expect(remove.success).toBe(false)
        const write = await writeCoworkerSkillFile(runtime, agentId, 'connector', 'references/x.md', 'new')
        expect(write.success).toBe(false)
        expect(await readFile(join(skillFolder('connector'), 'SKILL.md'), 'utf8')).toBe(original)
        expect(existsSync(join(skillFolder('connector'), 'references', 'x.md'))).toBe(false)
    })

    it('lets a local skill be updated and keeps the new body', async () => {
        await mkdir(skillFolder('local'), { recursive: true })
        await writeFile(join(skillFolder('local'), 'SKILL.md'), '---\nname: "local"\ndescription: "About local"\n---\n\n# local\n\nDo the thing.\n', 'utf8')
        const before = await getCoworkerSkill(runtime, agentId, 'local')
        const result = await updateCoworkerSkill(runtime, agentId, 'local', { body: '# local\n\nRewritten.', baseIdentity: before!.identity! })
        expect(result.success).toBe(true)
        expect(await readFile(join(skillFolder('local'), 'SKILL.md'), 'utf8')).toContain('Rewritten.')
        expect(imported).toHaveLength(0)
    })

    it('fails closed on create and file writes when the services registry cannot be read', async () => {
        await writeFile(registryFile(), '{damaged registry')
        const create = await createCoworkerSkill(runtime, agentId, { name: 'Web Research', description: '', body: '# body' })
        expect(create.success).toBe(false)
        expect(create.error).toBe('Could not check which skills an app owns. Try again.')
        expect(imported).toHaveLength(0)
        const write = await writeCoworkerSkillFile(runtime, agentId, 'local', 'references/x.md', 'content')
        expect(write.success).toBe(false)
        expect(write.error).toBe('Could not check which skills an app owns. Try again.')
    })

    it('re-checks ownership after admission and does not create the skill folder', async () => {
        const readOwners = skillStore.readSkillOwnersRegistry
        vi.spyOn(skillStore, 'readSkillOwnersRegistry').mockImplementationOnce(async (...args) => {
            const before = await readOwners(...args)
            await writeRegistry({ services: { 'demo-app': { skills: ['race-skill'] } } })
            return before
        })
        const result = await createCoworkerSkill(runtime, agentId, { name: 'Race Skill', description: '', body: '# body' })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/belongs to the/)
        expect(existsSync(skillFolder('race-skill'))).toBe(false)
        expect(imported).toHaveLength(0)
    })

    it('refuses a services registry whose services value is an array or a boolean', async () => {
        await writeRegistry({ services: [] })
        const listed = await createCoworkerSkill(runtime, agentId, { name: 'Web Research', description: '', body: '# body' })
        expect(listed.success).toBe(false)
        expect(listed.error).toBe('Could not check which skills an app owns. Try again.')
        expect(existsSync(skillFolder('web-research'))).toBe(false)
        await writeRegistry({ services: true })
        const flagged = await createCoworkerSkill(runtime, agentId, { name: 'Web Research', description: '', body: '# body' })
        expect(flagged.success).toBe(false)
        expect(flagged.error).toBe('Could not check which skills an app owns. Try again.')
        expect(imported).toHaveLength(0)
    })

    it('caps proposal sessions to the newest 100', async () => {
        const db = await openDesktopDatabase(root)
        for (let i = 2; i <= 106; i++) {
            await createDesktopSession(db, { agentId, engineSessionId: `engine-session-${i}`, title: `Session ${i}` })
        }
        await closeDesktopDatabase(root)
        for (let i = 1; i <= 106; i++) {
            proposals.push(fakeProposal(`proposal-${i}`, { sessionId: `engine-session-${i}`, createdAt: `2026-11-04T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` }))
        }
        const rows = await listCoworkerSkillProposals(runtime, agentId)
        // Sessions are newest first; the cap keeps the newest 100 of 106.
        expect(rows.availability).toBe('partial')
        expect(rows.failedSessions).toBe(6)
        expect(rows.proposals).toHaveLength(100)
        expect(rows.proposals.some(p => p.id === 'proposal-1')).toBe(false)
        expect(rows.proposals.some(p => p.id === 'proposal-106')).toBe(true)
    })

    it('keeps successful proposal rows when one session read fails', async () => {
        const db = await openDesktopDatabase(root)
        await createDesktopSession(db, { agentId, engineSessionId: 'engine-session-2', title: 'Second' })
        await closeDesktopDatabase(root)
        failProposalSessions.add('engine-session-2')
        proposals.push(fakeProposal('proposal-ok', { sessionId: 'engine-session-1' }))
        proposals.push(fakeProposal('proposal-missing', { sessionId: 'engine-session-2' }))
        const rows = await listCoworkerSkillProposals(runtime, agentId)
        expect(rows.availability).toBe('partial')
        expect(rows.failedSessions).toBe(1)
        expect(rows.proposals.map(proposal => proposal.id)).toEqual(['proposal-ok'])
    })

    it('reports proposals unavailable when every capped session read fails', async () => {
        failProposalSessions.add('engine-session-1')
        proposals.push(fakeProposal('proposal-1'))
        const rows = await listCoworkerSkillProposals(runtime, agentId)
        expect(rows.availability).toBe('unavailable')
        expect(rows.proposals).toEqual([])
        expect(rows.failedSessions).toBe(1)
    })

    it('returns a complete empty snapshot when the coworker has no engine sessions', async () => {
        const db = await openDesktopDatabase(root)
        await db.execute({ sql: 'DELETE FROM desktop_sessions', args: [] })
        await closeDesktopDatabase(root)
        const rows = await listCoworkerSkillProposals(runtime, agentId)
        expect(rows).toEqual({ availability: 'complete', proposals: [] })
    })

    it('maps a missing proposal to a surfaced error instead of a thrown request failure', async () => {
        const result = await decideCoworkerSkillProposal(runtime, agentId, 'missing-1', 'accept')
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/Proposal not found/)
    })

    it('decides a pending proposal against the engine and returns the updated row', async () => {
        proposals.push(fakeProposal('proposal-1'))
        const result = await decideCoworkerSkillProposal(runtime, agentId, 'proposal-1', 'accept')
        expect(result.success).toBe(true)
        expect(result.proposal?.status).toBe('accepted')
    })

    it('returns the confined manifest identity and refuses an editor based on an older version', async () => {
        await mkdir(skillFolder('local'), { recursive: true })
        const file = join(skillFolder('local'), 'SKILL.md')
        await writeFile(file, '---\nname: local\ndescription: First\n---\n\nOriginal.\n')
        const before = await getCoworkerSkill(runtime, agentId, 'local')
        expect(before?.identity).toMatch(/:complete$/)
        await writeFile(file, '---\nname: local\ndescription: Changed elsewhere\n---\n\nKeep these newer bytes.\n')
        const result = await updateCoworkerSkill(runtime, agentId, 'local', { body: 'Old editor overwrite', baseIdentity: before!.identity! })
        expect(result).toMatchObject({ success: false, status: 409 })
        expect(await readFile(file, 'utf8')).toContain('Keep these newer bytes.')
        const current = await getCoworkerSkill(runtime, agentId, 'local')
        expect(current?.identity).not.toBe(before!.identity)
        expect((await updateCoworkerSkill(runtime, agentId, 'local', { body: 'Current edit', baseIdentity: current!.identity! })).success).toBe(true)
        expect((await updateCoworkerSkill(runtime, agentId, 'local', { body: 'Unversioned', baseIdentity: '' }))).toMatchObject({ success: false, status: 400 })
    })

    it('refuses a symlinked ownership registry instead of trusting the generic engine file reader', async () => {
        const outside = join(root, 'outside-registry.json')
        await writeFile(outside, '{"services":{}}')
        await rm(registryFile())
        await symlink(outside, registryFile())
        const result = await createCoworkerSkill(runtime, agentId, { name: 'Private', description: '', body: 'Keep confined.' })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/Could not check/)
        expect(existsSync(skillFolder('private'))).toBe(false)
        expect(registryReads).toBe(0)
    })

    it('scoped proposal reads and decisions bind a local chat rather than accepting an engine session id', async () => {
        const db = await openDesktopDatabase(root)
        const sibling = await createDesktopSession(db, { agentId, engineSessionId: 'engine-session-2', title: 'Sibling' })
        proposals.push(fakeProposal('one'), fakeProposal('two', { sessionId: 'engine-session-2' }))
        const snapshot = await listCoworkerSkillProposals(runtime, agentId, localSessionId)
        expect(snapshot.proposals.map(row => row.id)).toEqual(['one'])
        expect(proposalReads).toEqual(['engine-session-1'])
        await expect(listCoworkerSkillProposals(runtime, agentId, 'engine-session-1')).rejects.toMatchObject({ status: 404 })
        expect(await decideCoworkerSkillProposal(runtime, agentId, 'one', 'accept', sibling.id)).toMatchObject({ success: false, status: 404 })
        expect(decisions).toEqual([])
        expect(await decideCoworkerSkillProposal(runtime, agentId, 'one', 'accept', localSessionId)).toMatchObject({ success: true, proposal: { id: 'one', status: 'accepted' } })
        expect(decisions).toEqual(['one:accept'])
    })

    it('rejects a different coworker’s local chat before reading or deciding its proposals', async () => {
        const db = await openDesktopDatabase(root)
        const other = await createDesktopAgent(db, { engineAgentId: 'engine-other', name: 'Other' })
        const foreign = await createDesktopSession(db, { agentId: other.id, engineSessionId: 'engine-other-session', title: 'Other chat' })
        await expect(listCoworkerSkillProposals(runtime, agentId, foreign.id)).rejects.toMatchObject({ status: 404 })
        expect(await decideCoworkerSkillProposal(runtime, agentId, 'foreign', 'accept', foreign.id)).toMatchObject({ success: false, status: 404 })
        expect(proposalReads).toEqual([]); expect(decisions).toEqual([])
    })

    it('a wrong-session engine row cannot appear in chat or authorize a decision', async () => {
        proposalOverrides.set('engine-session-1', [fakeProposal('foreign', { sessionId: 'engine-session-other' })])
        expect(await listCoworkerSkillProposals(runtime, agentId, localSessionId)).toEqual({ availability: 'unavailable', proposals: [], failedSessions: 1 })
        expect(await decideCoworkerSkillProposal(runtime, agentId, 'foreign', 'accept', localSessionId)).toMatchObject({ success: false, status: 502 })
        expect(decisions).toEqual([])
    })

    it('a changed local mapping after proposal discovery refuses the old-owner decision', async () => {
        proposals.push(fakeProposal('one'))
        const read = engineClient.listSkillProposals
        vi.spyOn(engineClient, 'listSkillProposals').mockImplementationOnce(async (...args) => {
            const rows = await read(...args)
            const db = await openDesktopDatabase(root)
            await db.execute({ sql: 'UPDATE desktop_agents SET engine_agent_id = ? WHERE id = ?', args: ['engine-replaced', agentId] })
            return rows
        })
        expect(await decideCoworkerSkillProposal(runtime, agentId, 'one', 'accept', localSessionId)).toMatchObject({ success: false, status: 409 })
        expect(decisions).toEqual([])
    })
})

// Bundled skill files are served by the confined store straight on the engine's folder layout
// (`<dataRoot>/workspaces/1/engine/agents/<engineAgentId>/skills/<slug>`), so these tests exercise
// real files on disk under the fake engine's agent folder.
describe('confined bundled-file store', () => {
    let server: Server
    let root: string
    let runtime: DesktopRuntime
    let agentId: string
    let registry: { services: Record<string, { skills: string[]; status: string; config: Record<string, string>; installedAt: string }> }

    const skillDir = (slug: string) => join(root, 'workspaces', '1', 'engine', 'agents', 'engine-agent-1', 'skills', slug)

    beforeEach(async () => {
        registry = { services: {} }
        root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-desktop-skill-store-')))
        await mkdir(join(root, 'workspaces', '1', 'engine', 'agents', 'engine-agent-1', 'workspace'), { recursive: true })
        server = createServer(async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            if (url.pathname === '/agents/engine-agent-1/files/read' && url.searchParams.get('path') === '.rerun/services.json') {
                return json(res, { content: JSON.stringify(registry), truncated: false })
            }
            return json(res, { error: 'not found' }, 404)
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Missing test engine address')
        runtime = {
            protocolVersion: 1,
            launchNonce: 'skill-store-launch',
            buildId: 'skill-store-build',
            workspaceId: 1,
            dataRoot: root,
            app: { origin: 'http://127.0.0.1:3100', sessionToken: 's'.repeat(48) },
            engine: { origin: `http://127.0.0.1:${address.port}`, apiKey: 'engine-secret' },
        }
        const db = await openDesktopDatabase(root)
        await createDesktopAgent(db, { engineAgentId: 'engine-agent-1', name: 'Coworker' })
        const agents = await listDesktopAgents(db)
        agentId = agents[0]!.id
        await closeDesktopDatabase(root)
    })

    afterEach(async () => {
        setSkillPublishHooksForTests(null)
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        vi.restoreAllMocks()
        await closeDesktopDatabase(root)
        await rm(root, { recursive: true, force: true })
    })

    it('reads a bundled file straight from the engine skill folder', async () => {
        await mkdir(join(skillDir('local'), 'references'), { recursive: true })
        await writeFile(join(skillDir('local'), 'references', 'checklist.md'), '# checklist', 'utf8')
        const read = await readCoworkerSkillFile(runtime, agentId, 'local', 'references/checklist.md')
        expect(read?.content).toBe('# checklist')
        expect(read?.truncated).toBe(false)
    })

    it('returns null for a bundled file that does not exist', async () => {
        await mkdir(skillDir('local'), { recursive: true })
        const read = await readCoworkerSkillFile(runtime, agentId, 'local', 'references/missing.md')
        expect(read).toBeNull()
    })

    it('writes a bundled file to disk inside the engine skill folder', async () => {
        await mkdir(skillDir('local'), { recursive: true })
        const result = await writeCoworkerSkillFile(runtime, agentId, 'local', 'references/notes.md', 'hello')
        expect(result.success).toBe(true)
        expect(await readFile(join(skillDir('local'), 'references', 'notes.md'), 'utf8')).toBe('hello')
    })

    it('create-only refuses an existing file and leaves its bytes untouched', async () => {
        await mkdir(join(skillDir('local'), 'references'), { recursive: true })
        await writeFile(join(skillDir('local'), 'references', 'x.md'), 'existing', 'utf8')
        const result = await writeCoworkerSkillFile(runtime, agentId, 'local', 'references/x.md', 'overwrite', { createOnly: true })
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/already exists/)
        expect(await readFile(join(skillDir('local'), 'references', 'x.md'), 'utf8')).toBe('existing')
    })

    it('refuses a top-level manifest alias in any case and leaves the manifest alone', async () => {
        await mkdir(skillDir('local'), { recursive: true })
        await writeFile(join(skillDir('local'), 'SKILL.md'), '# original', 'utf8')
        const result = await writeCoworkerSkillFile(runtime, agentId, 'local', 'skill.md', '# changed')
        expect(result.success).toBe(false)
        expect(result.error).toMatch(/other than SKILL\.md/)
        expect(await readFile(join(skillDir('local'), 'SKILL.md'), 'utf8')).toBe('# original')
    })

    it('refuses paths that escape the skill folder', async () => {
        await mkdir(skillDir('local'), { recursive: true })
        const result = await writeCoworkerSkillFile(runtime, agentId, 'local', '../escape.md', 'no')
        expect(result.success).toBe(false)
        expect(await readdir(skillDir('local'))).toHaveLength(0)
    })

    it('refuses to write through a symlinked component', async () => {
        const outside = join(root, 'outside')
        await mkdir(outside, { recursive: true })
        await mkdir(skillDir('local'), { recursive: true })
        await symlink(outside, join(skillDir('local'), 'references'))
        const result = await writeCoworkerSkillFile(runtime, agentId, 'local', 'references/x.md', 'no')
        expect(result.success).toBe(false)
        expect(await readdir(outside)).toHaveLength(0)
    })

    it('marks a 150000 character ASCII read truncated and refuses to save that page over the tail', async () => {
        await mkdir(join(skillDir('local'), 'references'), { recursive: true })
        const file = join(skillDir('local'), 'references', 'long.md')
        await writeFile(file, 'a'.repeat(150_000), 'utf8')
        const read = await readCoworkerSkillFile(runtime, agentId, 'local', 'references/long.md')
        expect(read?.truncated).toBe(true)
        expect(read?.content).toHaveLength(TEXT_FILE_PAGE_CHARS)
        const save = await writeCoworkerSkillFile(runtime, agentId, 'local', 'references/long.md', read!.content, { completeRead: true, baseIdentity: read!.identity })
        expect(save.success).toBe(false)
        expect(save.error).toMatch(/partly read/)
        expect(await readFile(file, 'utf8')).toBe('a'.repeat(150_000))
    })

    it('marks a multibyte file truncated and keeps the returned page inside the character cap', async () => {
        await mkdir(join(skillDir('local'), 'references'), { recursive: true })
        const file = join(skillDir('local'), 'references', 'emoji.md')
        await writeFile(file, '😀'.repeat(100_001), 'utf8')
        const read = await readCoworkerSkillFile(runtime, agentId, 'local', 'references/emoji.md')
        expect(read?.truncated).toBe(true)
        expect(read!.content.length).toBeLessThanOrEqual(TEXT_FILE_PAGE_CHARS)
    })

    it('does not write through a skill directory swapped for a symlink before mkdir', async () => {
        const outside = join(root, 'outside-swap')
        await mkdir(outside, { recursive: true })
        await mkdir(skillDir('local'), { recursive: true })
        setSkillPublishHooksForTests({
            beforeDirectoryCreate: async () => {
                await rm(skillDir('local'), { recursive: true, force: true })
                await symlink(outside, skillDir('local'))
            },
        })
        const result = await writeCoworkerSkillFile(runtime, agentId, 'local', 'references/x.md', 'no')
        expect(result.success).toBe(false)
        expect(await readdir(outside)).toEqual([])
    })

    it('does not publish a file into a skill directory replaced during the write', async () => {
        await mkdir(skillDir('local'), { recursive: true })
        await writeFile(join(skillDir('local'), 'keep.md'), 'keep', 'utf8')
        setSkillPublishHooksForTests({
            beforeFilePublish: async () => {
                await rename(skillDir('local'), join(root, 'moved-skill'))
                await mkdir(skillDir('local'))
            },
        })
        const result = await writeCoworkerSkillFile(runtime, agentId, 'local', 'notes.md', 'new')
        expect(result.success).toBe(false)
        expect(await readdir(skillDir('local'))).toEqual([])
    })

    it('deletes a bundled file', async () => {
        await mkdir(join(skillDir('local'), 'references'), { recursive: true })
        await writeFile(join(skillDir('local'), 'references', 'gone.md'), 'bye', 'utf8')
        const result = await deleteCoworkerSkillFile(runtime, agentId, 'local', 'references/gone.md')
        expect(result.success).toBe(true)
        expect(await readFile(join(skillDir('local'), 'references', 'gone.md'), 'utf8').catch(() => null)).toBeNull()
    })
})
