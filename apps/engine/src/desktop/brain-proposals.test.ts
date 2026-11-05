import { link, lstat, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type { RunContext } from '../runtime/context.js'

const configs = vi.hoisted(() => new Map<string, { enabled?: boolean; name?: string; tools?: { brain?: boolean; desktopToolGrants?: Record<string, boolean> } }>())
vi.mock('../agents/loader.js', () => ({ readAgentConfig: async (id: string) => configs.get(id) ?? null }))

const engine = realpathSync(mkdtempSync(join(tmpdir(), 'rerun-brain-')))
process.env.RERUN_DATA_DIR = engine
process.env.RERUN_DESKTOP_APP = '1'

const {
    countDesktopBrainProposals,
    decideDesktopBrainProposal,
    desktopBrainProposalFingerprint,
    insertDesktopBrainProposal,
    listDesktopBrainProposals,
    readDesktopBrainPage,
    searchDesktopBrain,
} = await import('./brain-proposals.js')
const { desktopBrainTools } = await import('./brain-tools.js')

const call = { toolCallId: 'brain-test', messages: [] }
const ALREADY = 'This exact change was already proposed once. Nothing sent, and do not raise it again.'

function allow(id: string, name: string) {
    const config = { enabled: true, name, tools: { brain: true, desktopToolGrants: { brain: true } } }
    configs.set(id, config)
    return config
}

function context(id: string, config = configs.get(id), signal?: AbortSignal) {
    return { agent: { id, config }, sessionId: `session-${id}`, abortSignal: signal } as RunContext
}

function proposalInput(overrides: Record<string, unknown> = {}) {
    return {
        slug: 'roadmap',
        title: 'Roadmap',
        headline: 'Roadmap is drafted',
        highlights: [{ label: 'Plan', before: null, after: 'Drafted' }],
        type: 'note' as const,
        content: 'The roadmap is drafted.',
        reason: 'The user asked for a roadmap.',
        sources: ['told by the user in chat'],
        baseHash: null as string | null,
        root: '/etc',
        engineId: 'not-an-engine',
        scope: 'private',
        ...overrides,
    }
}

async function writeBrain(slug: string, content: string, title = slug, updatedBy = 'user') {
    const dir = join(engine, 'brain')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${slug}.md`), `---\ntitle: ${title}\ntype: note\nupdatedBy: ${updatedBy}\nupdatedAt: "2026-01-01T00:00:00.000Z"\nsources:\n  - told by the user\n---\n${content}\n`, { mode: 0o600 })
}

async function reset() {
    for (const name of ['brain', 'brain-proposals', 'agents', '.deleting']) {
        const path = join(engine, name)
        const info = await lstat(path).catch(() => null)
        if (!info) continue
        if (info.isSymbolicLink()) await unlink(path)
        else await rm(path, { recursive: true, force: true })
    }
    await writeBrain('pricing', 'publicpricingtoken is listed.\n\n## Plan\nSee [[voice]].', 'Pricing', 'seed')
    await writeBrain('voice', 'The company voice mentions [[pricing]].', 'Voice')
}

await reset()
afterEach(reset)
afterAll(async () => { await rm(engine, { recursive: true, force: true }) })

async function bytes(slug: string) {
    return readFile(join(engine, 'brain', `${slug}.md`))
}

it('accepts and retries without writing the page, and keeps the opposite decision', async () => {
    const before = await bytes('pricing')
    const page = await readDesktopBrainPage(engine, 'pricing')
    allow('alpha', 'Ada')
    const tools = desktopBrainTools(context('alpha'))
    const proposed = JSON.parse(String(await tools.brain_propose!.execute!(proposalInput({
        slug: 'pricing', title: 'Pricing', content: 'The public price changed.', baseHash: page!.hash,
    }), call)))
    expect(proposed.status).toBe('proposed')
    expect(await bytes('pricing')).toEqual(before)
    const info = await lstat(join(engine, 'brain-proposals', `${proposed.proposalId}.json`))
    expect(info.mode & 0o777).toBe(0o600)
    expect(info.nlink).toBe(1)

    const accepted = await decideDesktopBrainProposal(engine, proposed.proposalId, 'accept', { content: 'Person edit', title: 'Person title' })
    expect(accepted).toMatchObject({
        applied: false, conflict: false, unchanged: false,
        pageWrite: { content: 'Person edit', title: 'Person title', force: false, author: 'agent:Ada', baseHash: page!.hash, proposalId: proposed.proposalId },
    })
    expect(accepted.proposal.content).toBe('The public price changed.')
    expect(accepted.proposal.decidedBy).toBe('user:desktop')
    expect(await bytes('pricing')).toEqual(before)

    const again = await decideDesktopBrainProposal(engine, proposed.proposalId, 'accept', { content: 'A later edit' })
    expect(again.unchanged).toBe(true)
    expect(again.proposal.decidedAt).toBe(accepted.proposal.decidedAt)
    expect(again.pageWrite).toEqual(accepted.pageWrite)
    expect(await bytes('pricing')).toEqual(before)

    await expect(decideDesktopBrainProposal(engine, proposed.proposalId, 'dismiss')).rejects.toMatchObject({ status: 409 })
    expect((await listDesktopBrainProposals(engine, 'accepted')).find(row => row.id === proposed.proposalId)?.status).toBe('accepted')
    expect(await bytes('pricing')).toEqual(before)
})

it('keeps a stale or conflicting proposal visible and does not write the page', async () => {
    const page = await readDesktopBrainPage(engine, 'pricing')
    allow('alpha', 'Ada')
    const tools = desktopBrainTools(context('alpha'))
    const proposed = JSON.parse(String(await tools.brain_propose!.execute!(proposalInput({
        slug: 'pricing', title: 'Pricing', content: 'Replacement that must not land.', baseHash: page!.hash,
    }), call)))
    await writeFile(join(engine, 'brain', 'pricing.md'), `${await readFile(join(engine, 'brain', 'pricing.md'), 'utf8')}\nlive edit\n`)
    const live = await readFile(join(engine, 'brain', 'pricing.md'))
    await expect(decideDesktopBrainProposal(engine, proposed.proposalId, 'accept')).rejects.toMatchObject({
        status: 409, message: 'The page changed since the coworker read it. The proposal is still waiting, and the page was not written.',
    })
    expect(await listDesktopBrainProposals(engine, 'proposed')).toMatchObject([{ id: proposed.proposalId, status: 'proposed', outdated: true }])
    expect(await readFile(join(engine, 'brain', 'pricing.md'))).toEqual(live)

    const created = JSON.parse(String(await tools.brain_propose!.execute!(proposalInput({ content: 'A page that is not written yet.' }), call)))
    await writeBrain('roadmap', 'The live page already exists.', 'Roadmap')
    await expect(decideDesktopBrainProposal(engine, created.proposalId, 'accept')).rejects.toMatchObject({ status: 409 })
    expect((await listDesktopBrainProposals(engine, 'proposed')).find(row => row.id === created.proposalId)).toMatchObject({ status: 'proposed', outdated: true })
    expect(await readFile(join(engine, 'brain', 'roadmap.md'), 'utf8')).toContain('The live page already exists.')
    expect(await readFile(join(engine, 'brain', 'roadmap.md'), 'utf8')).not.toContain('A page that is not written yet.')
})

it('preserves a dismissal and blocks the same change, including from another coworker', async () => {
    allow('alpha', 'Ada')
    allow('bravo', 'Bea')
    const alpha = desktopBrainTools(context('alpha'))
    const bravo = desktopBrainTools(context('bravo'))
    const first = JSON.parse(String(await alpha.brain_propose!.execute!(proposalInput(), call)))
    const dismissed = await decideDesktopBrainProposal(engine, first.proposalId, 'dismiss')
    expect(dismissed.pageWrite).toBeNull()
    expect(await decideDesktopBrainProposal(engine, first.proposalId, 'dismiss')).toMatchObject({ unchanged: true, pageWrite: null })
    expect(dismissed.proposal.decidedAt).toBe((await listDesktopBrainProposals(engine, 'dismissed'))[0]?.decidedAt)
    await expect(decideDesktopBrainProposal(engine, first.proposalId, 'accept')).rejects.toThrow('already dismissed')
    expect(await alpha.brain_propose!.execute!(proposalInput(), call)).toBe(ALREADY)
    expect(await bravo.brain_propose!.execute!(proposalInput(), call)).toBe(ALREADY)
    expect((await readdir(join(engine, 'brain-proposals'))).filter(name => name.endsWith('.json'))).toEqual([`${first.proposalId}.json`])
})

it('replaces one coworker’s open proposal and lets another coworker propose different text', async () => {
    allow('alpha', 'Ada')
    allow('bravo', 'Bea')
    const alpha = desktopBrainTools(context('alpha'))
    const bravo = desktopBrainTools(context('bravo'))
    const first = JSON.parse(String(await alpha.brain_propose!.execute!(proposalInput({ baseHash: 'ignored-on-create' }), call)))
    const updated = JSON.parse(String(await alpha.brain_propose!.execute!(proposalInput({ content: 'The roadmap was revised.' }), call)))
    expect(updated).toMatchObject({ status: 'updated', proposalId: first.proposalId })
    const other = JSON.parse(String(await bravo.brain_propose!.execute!(proposalInput({ content: 'Bea drafted a different roadmap.' }), call)))
    expect(other.proposalId).not.toBe(first.proposalId)
    const stored = JSON.parse(await readFile(join(engine, 'brain-proposals', `${first.proposalId}.json`), 'utf8'))
    expect(stored.baseHash).toBeNull()
    expect(stored.mode).toBe('create')
    await expect(readFile(join(engine, 'brain', 'roadmap.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    const seenByAda = await alpha.brain_read!.execute!({ slug: 'pricing' }, call)
    expect(await bravo.brain_read!.execute!({ slug: 'pricing' }, call)).toBe(seenByAda)
})

it('searches keywords in the company brain and does not read a private memory or call embeddings', async () => {
    allow('alpha', 'Ada')
    const memory = join(engine, 'agents', 'alpha', 'memory')
    await mkdir(memory, { recursive: true })
    await writeFile(join(memory, 'note.md'), 'privatememorytoken stays private')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('hosted embed must not be called'))
    try {
        const tools = desktopBrainTools(context('alpha'))
        const found = String(await tools.brain_search!.execute!({ query: 'publicpricingtoken', limit: 5 }, call))
        expect(found).toContain('[[pricing]] Pricing')
        expect(found).toContain('publicpricingtoken')
        expect(found).toContain('[[voice]]')
        expect(found).not.toContain('privatememorytoken')
        expect(String(await tools.brain_search!.execute!({ query: 'privatememorytoken', limit: 5 }, call))).toContain('Nothing in the company brain matches')
        expect(String(await tools.brain_read!.execute!({ slug: 'pricing' }, call))).toContain('unconfirmed sections: Plan (imported from the public web, nobody at the company confirmed them)')
        expect(fetchSpy).not.toHaveBeenCalled()
        expect((await searchDesktopBrain(engine, 'publicpricingtoken')).hits.map(hit => hit.slug)).toEqual(['pricing'])
    } finally { fetchSpy.mockRestore() }
})

it('refuses a missing hash, an identical page, a symlink, a linked proposal, and a stale decision lock', async () => {
    allow('alpha', 'Ada')
    const tools = desktopBrainTools(context('alpha'))
    const page = await readDesktopBrainPage(engine, 'pricing')
    const before = await bytes('pricing')
    expect(await tools.brain_propose!.execute!(proposalInput({ slug: 'pricing', title: 'Pricing', content: 'Changed.', baseHash: null }), call)).toContain('already exists')
    expect(await tools.brain_propose!.execute!(proposalInput({ slug: 'pricing', title: 'Pricing', content: 'Changed.', baseHash: 'stale-hash' }), call)).toContain('changed since you read it')
    expect(await tools.brain_propose!.execute!(proposalInput({
        slug: 'pricing', title: page!.title, type: page!.type, content: page!.content, baseHash: page!.hash,
    }), call)).toBe('This is identical to the current page. Nothing sent.')
    expect(await bytes('pricing')).toEqual(before)
    const secret = join(engine, 'agents', 'alpha', 'secret.md')
    await mkdir(join(engine, 'agents', 'alpha'), { recursive: true })
    await writeFile(secret, 'privatememorytoken')
    await symlink(secret, join(engine, 'brain', 'leak.md'))
    await expect(readDesktopBrainPage(engine, 'leak')).rejects.toMatchObject({ status: 400, message: 'That path is outside the company brain.' })
    expect(await searchDesktopBrain(engine, 'privatememorytoken')).toMatchObject({ hits: [] })

    await rm(join(engine, 'brain'), { recursive: true })
    await symlink(join(engine, 'agents'), join(engine, 'brain'))
    await expect(readDesktopBrainPage(engine, 'pricing')).rejects.toMatchObject({ status: 400, message: 'That path is outside the company brain.' })
    await expect(searchDesktopBrain(engine, 'publicpricingtoken')).rejects.toMatchObject({ status: 400 })

    await reset()
    const row = await insertDesktopBrainProposal(engine, {
        agentId: 'alpha', agentName: 'Ada', sessionId: 'session-alpha', slug: 'roadmap', mode: 'create', title: 'Roadmap',
        headline: 'Roadmap is drafted', highlights: [{ label: 'Plan', before: null, after: 'Drafted' }], type: 'note',
        content: 'The roadmap is drafted.', reason: 'The user asked for a roadmap.', sources: ['told by the user in chat'], baseHash: null,
        fingerprint: desktopBrainProposalFingerprint({ slug: 'roadmap', content: 'The roadmap is drafted.' }),
    })
    await mkdir(join(engine, 'agents', 'alpha'), { recursive: true })
    await link(join(engine, 'brain-proposals', `${row.id}.json`), join(engine, 'agents', 'alpha', 'copy.json'))
    await expect(listDesktopBrainProposals(engine, 'proposed')).rejects.toMatchObject({ status: 400, message: 'That path is outside the company brain.' })
    await unlink(join(engine, 'agents', 'alpha', 'copy.json'))
    await writeFile(join(engine, 'brain-proposals', `.${row.id}.lock`), '')
    await expect(decideDesktopBrainProposal(engine, row.id, 'accept')).rejects.toMatchObject({ status: 409, message: 'This proposal is being decided. Try again.' })
    expect((await listDesktopBrainProposals(engine, 'proposed'))[0]?.status).toBe('proposed')
})

it('counts every open proposal while the visible list stays capped, and a corrupt file is not an empty list', async () => {
    for (let index = 0; index < 101; index += 1) {
        await insertDesktopBrainProposal(engine, {
            agentId: 'alpha', agentName: 'Ada', sessionId: 'session-alpha', slug: 'notes', mode: 'create', title: `Note ${index}`,
            headline: 'A note', highlights: [{ label: 'Note', before: null, after: 'Filed' }], type: 'note',
            content: `note ${index}`, reason: 'Filed for review.', sources: [], baseHash: null,
            fingerprint: desktopBrainProposalFingerprint({ slug: 'notes', content: `note ${index}` }),
        })
    }
    expect(await countDesktopBrainProposals(engine)).toBe(101)
    expect(await listDesktopBrainProposals(engine, 'proposed')).toHaveLength(100)
    await writeFile(join(engine, 'brain-proposals', `${'b'.repeat(21)}.json`), '{', { mode: 0o600 })
    await expect(listDesktopBrainProposals(engine)).rejects.toMatchObject({ status: 500, message: 'A proposal could not be read.' })
    await expect(countDesktopBrainProposals(engine)).rejects.toMatchObject({ status: 500 })
    await expect(listDesktopBrainProposals(join(engine, 'missing-engine'))).rejects.toMatchObject({ status: 404, message: 'The company brain is not ready.' })
})

it('registers only the three review tools and rechecks the grant, cancellation, and deletion', async () => {
    const config = allow('alpha', 'Ada')
    const tools = desktopBrainTools(context('alpha', config))
    expect(Object.keys(tools).sort()).toEqual(['brain_propose', 'brain_read', 'brain_search'])
    expect(Object.keys(desktopBrainTools(context('alpha', { enabled: true, name: 'Ada', tools: { brain: true } })))).toEqual([])
    expect(Object.keys(desktopBrainTools(context('alpha', { enabled: false, name: 'Ada', tools: config.tools })))).toEqual([])
    expect(Object.keys(desktopBrainTools(context('alpha', { enabled: true, name: 'Ada', tools: { brain: false, desktopToolGrants: { brain: true } } })))).toEqual([])
    config.tools.desktopToolGrants.brain = false
    await expect(tools.brain_read!.execute!({ slug: 'pricing' }, call)).rejects.toThrow('turned off')
    config.tools.desktopToolGrants.brain = true
    const controller = new AbortController()
    const live = desktopBrainTools(context('alpha', config, controller.signal))
    controller.abort()
    await expect(live.brain_search!.execute!({ query: 'pricing', limit: 5 }, call)).rejects.toMatchObject({ name: 'AbortError' })
    await mkdir(join(engine, '.deleting'), { recursive: true })
    await writeFile(join(engine, '.deleting', 'alpha'), '')
    await expect(tools.brain_read!.execute!({ slug: 'pricing' }, call)).rejects.toThrow('being deleted')
})
