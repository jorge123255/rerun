import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopBrainProposalFingerprint, insertDesktopBrainProposal, readDesktopBrainPage, type DesktopBrainProposalDraft } from '../../../../../../engine/src/desktop/brain-proposals'

vi.mock('server-only', () => ({}))

import { POST as acceptProposal } from './[proposalId]/accept/route'
import { POST as dismissProposal } from './[proposalId]/dismiss/route'
import { GET as countProposals } from './count/route'
import { GET as listProposals } from './route'

const env = { ...process.env }
const origin = 'http://127.0.0.1:3189'
const token = 's'.repeat(48)
let root: string

function headers(authenticated = true) {
    return { host: new URL(origin).host, origin, ...(authenticated ? { cookie: `rerun-desktop-session=${token}` } : {}) }
}

function request(path = '', authenticated = true) {
    return new Request(`${origin}/api/desktop/brain/proposals${path}`, { headers: headers(authenticated) })
}

function post(id: string, action: 'accept' | 'dismiss', body: unknown) {
    return new Request(`${origin}/api/desktop/brain/proposals/${id}/${action}`, {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-desktop-brain-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'brain', buildId: 'brain-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:1', apiKey: 'unused' },
    }), { mode: 0o600 })
})

afterEach(async () => {
    process.env = { ...env }
    await rm(root, { recursive: true, force: true })
})

async function engineDir() {
    const engine = join(root, 'workspaces', '1', 'engine')
    await mkdir(engine, { recursive: true })
    return realpath(engine)
}

function draft(overrides: Partial<DesktopBrainProposalDraft> = {}): DesktopBrainProposalDraft {
    const row = {
        agentId: 'alpha', agentName: 'Ada', sessionId: 'session-alpha', slug: 'pricing', mode: 'create' as const,
        title: 'Pricing', headline: 'Pricing is now public', highlights: [{ label: 'Price', before: null, after: 'Public' }],
        type: 'note' as const, content: 'The coworker proposed this page.', reason: 'The user said so.',
        sources: ['told by the user in chat'], baseHash: null, fingerprint: '', ...overrides,
    }
    return { ...row, fingerprint: overrides.fingerprint ?? desktopBrainProposalFingerprint(row) }
}

async function writePage(engine: string, slug: string, content: string) {
    await mkdir(join(engine, 'brain'), { recursive: true })
    const raw = `---\ntitle: Pricing\ntype: note\nupdatedBy: user\nupdatedAt: "2026-01-01T00:00:00.000Z"\nsources:\n  - told by the user\n---\n${content}\n`
    await writeFile(join(engine, 'brain', `${slug}.md`), raw, { mode: 0o600 })
    return raw
}

test('a missing engine is an error and a missing proposal folder is an empty inbox', async () => {
    const missing = await listProposals(request())
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'The company brain is not ready.' })
    expect((await countProposals(request('/count'))).status).toBe(404)
    const engine = await engineDir()
    expect(await (await listProposals(request('?root=%2Fetc&engineId=no'))).json()).toEqual({ proposals: [] })
    expect(await (await countProposals(request('/count'))).json()).toEqual({ count: 0 })
    expect(await lstat(engine).then(info => info.isSymbolicLink())).toBe(false)
})

test('a corrupt proposal or a symlink is not returned as an empty success', async () => {
    const engine = await engineDir()
    await mkdir(join(engine, 'brain-proposals'), { recursive: true })
    await writeFile(join(engine, 'brain-proposals', `${'b'.repeat(21)}.json`), '{', { mode: 0o600 })
    const corrupt = await listProposals(request())
    expect(corrupt.status).toBe(500)
    expect(await corrupt.json()).toEqual({ error: 'A proposal could not be read.' })
    expect((await countProposals(request('/count'))).status).toBe(500)
    await rm(join(engine, 'brain-proposals'), { recursive: true })
    const outside = join(root, 'outside-proposal.json')
    await writeFile(outside, '{"secret":"private-only"}')
    await symlink(outside, join(engine, 'brain-proposals'))
    const linked = await listProposals(request())
    expect(linked.status).toBe(400)
    expect(await linked.text()).not.toContain('private-only')
})

test('accept and dismiss record the decision, reject a client author, and leave the page bytes unchanged', async () => {
    const engine = await engineDir()
    const page = await writePage(engine, 'pricing', 'publicpricingtoken stays on the page.')
    const current = await readDesktopBrainPage(engine, 'pricing')
    const open = await insertDesktopBrainProposal(engine, draft({ mode: 'edit', baseHash: current!.hash, content: 'The coworker proposed a change.' }))
    const unauthenticated = post(open.id, 'accept', {})
    unauthenticated.headers.delete('cookie')
    expect((await acceptProposal(unauthenticated, { params: Promise.resolve({ proposalId: open.id }) })).status).toBe(401)

    const rejected = await acceptProposal(post(open.id, 'accept', { decidedBy: 'user:hub', content: 'Injected' }), { params: Promise.resolve({ proposalId: open.id }) })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toEqual({ error: 'The decision author is set by this Mac.' })
    expect(await readFile(join(engine, 'brain', 'pricing.md'), 'utf8')).toBe(page)

    const accepted = await acceptProposal(post(open.id, 'accept', { content: 'Person edit', title: 'Person title', type: 'decision', root: '/etc' }), { params: Promise.resolve({ proposalId: open.id }) })
    expect(accepted.status).toBe(400)
    expect(await readFile(join(engine, 'brain', 'pricing.md'), 'utf8')).toBe(page)

    const saved = await acceptProposal(post(open.id, 'accept', { content: 'Person edit', title: 'Person title', type: 'decision' }), { params: Promise.resolve({ proposalId: open.id }) })
    expect(saved.status).toBe(200)
    expect(saved.headers.get('cache-control')).toBe('no-store')
    const body = await saved.json()
    expect(body).toMatchObject({
        applied: false, conflict: false, unchanged: false,
        proposal: { status: 'accepted', decidedBy: 'user:desktop', content: 'The coworker proposed a change.' },
        pageWrite: { content: 'Person edit', title: 'Person title', type: 'decision', force: false, author: 'agent:Ada', baseHash: current!.hash },
    })
    expect(await readFile(join(engine, 'brain', 'pricing.md'), 'utf8')).toBe(page)
    const again = await (await acceptProposal(post(open.id, 'accept', {}), { params: Promise.resolve({ proposalId: open.id }) })).json()
    expect(again.unchanged).toBe(true)
    expect(again.proposal.decidedAt).toBe(body.proposal.decidedAt)
    expect(again.pageWrite).toEqual(body.pageWrite)
    const opposite = await dismissProposal(post(open.id, 'dismiss', { decidedBy: 'user:hub' }), { params: Promise.resolve({ proposalId: open.id }) })
    expect(opposite.status).toBe(409)
    expect(await readFile(join(engine, 'brain', 'pricing.md'), 'utf8')).toBe(page)

    const other = await insertDesktopBrainProposal(engine, draft({ slug: 'roadmap', content: 'A second open proposal.' }))
    const inbox = await (await listProposals(request())).json()
    expect(inbox.proposals.map((row: { id: string; status: string }) => row.id)).toEqual([other.id])
    expect(inbox.proposals.every((row: { status: string }) => row.status === 'proposed')).toBe(true)
    const decided = await (await listProposals(request('?status=accepted'))).json()
    expect(decided.proposals.map((row: { id: string }) => row.id)).toEqual([open.id])
    expect(await (await countProposals(request('/count'))).json()).toEqual({ count: 1 })
    expect((await listProposals(request('?status=all'))).status).toBe(400)
})

test('a stale accept stays proposed and a create acceptance does not add a page', async () => {
    const engine = await engineDir()
    const page = await writePage(engine, 'pricing', 'publicpricingtoken stays on the page.')
    const current = await readDesktopBrainPage(engine, 'pricing')
    const edit = await insertDesktopBrainProposal(engine, draft({ mode: 'edit', baseHash: current!.hash }))
    await writeFile(join(engine, 'brain', 'pricing.md'), `${page}\nlive edit\n`)
    const stale = await acceptProposal(post(edit.id, 'accept', {}), { params: Promise.resolve({ proposalId: edit.id }) })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'The page changed since the coworker read it. The proposal is still waiting, and the page was not written.' })
    const waiting = await (await listProposals(request())).json()
    expect(waiting.proposals).toMatchObject([{ id: edit.id, status: 'proposed', outdated: true }])
    expect(await readFile(join(engine, 'brain', 'pricing.md'), 'utf8')).toContain('live edit')
    expect(await readFile(join(engine, 'brain', 'pricing.md'), 'utf8')).not.toContain('The coworker proposed this page.')

    const created = await insertDesktopBrainProposal(engine, draft({ slug: 'roadmap', content: 'Do not create this file.' }))
    const response = await acceptProposal(post(created.id, 'accept', {}), { params: Promise.resolve({ proposalId: created.id }) })
    const body = await response.json()
    expect(body.pageWrite).toMatchObject({ slug: 'roadmap', baseHash: null, force: false, content: 'Do not create this file.' })
    await expect(readFile(join(engine, 'brain', 'roadmap.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
