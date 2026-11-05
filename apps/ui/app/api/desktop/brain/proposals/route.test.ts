import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { POST as acceptProposal } from './[proposalId]/accept/route'
import { POST as dismissProposal } from './[proposalId]/dismiss/route'
import { GET as countProposals } from './count/route'
import { GET as listProposals } from './route'

const env = { ...process.env }, origin = 'http://127.0.0.1:3189', token = 's'.repeat(48)
let root: string
const headers = { host: new URL(origin).host, origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }
const context = { params: Promise.resolve({ proposalId: 'proposal-one' }) }
const decision = { reviewedFingerprint: 'a'.repeat(64), expectedPageHash: null, requestId: 'receipt-one' }
const post = (body: unknown, extra: Record<string, string> = {}) => new Request(`${origin}/api/desktop/brain/proposals/proposal-one/accept`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) })
const get = (suffix = '', extra: Record<string, string> = {}) => new Request(`${origin}/api/desktop/brain/proposals${suffix}`, { headers: { ...headers, ...extra } })
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-desktop-brain-proxy-')))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ protocolVersion: 1, launchNonce: 'brain', buildId: 'brain-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:3190', apiKey: 'engine-secret' } }), { mode: 0o600 })
})
afterEach(async () => { process.env = { ...env }; vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
it('authenticates and checks origin before accessing engine storage', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not send'))
    expect((await listProposals(get('', { cookie: '' }))).status).toBe(401)
    expect((await acceptProposal(post(decision, { origin: 'https://outside.test' }), context)).status).toBe(403)
    expect(fetcher).not.toHaveBeenCalled()
})
it('rejects missing reviewed identities, forged authors and unbounded bodies before forwarding', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not send'))
    expect((await acceptProposal(post({}), context)).status).toBe(400)
    expect((await acceptProposal(post({ ...decision, decidedBy: 'user:forged' }), context)).status).toBe(400)
    expect((await dismissProposal(post({ ...decision, edits: { title: 'No' } }), context)).status).toBe(400)
    expect((await acceptProposal(post({ ...decision, padding: 'x'.repeat(300_001) }), context)).status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
})
it('proxies exact decisions only to the authenticated local engine, with redirects disabled', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 409 }))
    expect((await acceptProposal(post(decision), context)).status).toBe(409)
    const [url, options] = fetcher.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:3190/desktop/brain/proposals/proposal-one/accept')
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer engine-secret' } })
    expect(JSON.parse(options!.body as string)).toEqual(decision)
})
it('does not disguise missing/unavailable/malformed storage as an empty successful inbox', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }))
    expect((await listProposals(get())).status).toBe(503)
    fetcher.mockResolvedValueOnce(new Response('{}'))
    expect((await listProposals(get())).status).toBe(502)
    fetcher.mockResolvedValueOnce(new Response('{"proposals":[]}'))
    expect(await (await listProposals(get())).json()).toEqual({ proposals: [] })
    fetcher.mockResolvedValueOnce(new Response('{"count":2}'))
    expect(await (await countProposals(get('/count'))).json()).toEqual({ count: 2 })
})
