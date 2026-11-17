import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../auth', async original => ({ ...await original<typeof import('../auth')>(), authenticateDesktopEngineRequest: vi.fn(async () => { throw new Error('not the engine') }) }))
vi.mock('../database', () => ({ openDesktopDatabase: vi.fn() }))
vi.mock('../mcp-binding', () => ({ getDesktopRemoteMcpService: vi.fn() }))
vi.mock('@/lib/engine/client', () => ({ getAgent: vi.fn() }))
const { initializeDesktopRound61 } = await import('../round61-schema')
const { decideConnectorApproval, readConnectorApprovals } = await import('../connector-approvals/store')
const { fixtureGit } = await import('./git')
const { createRepositoryWorkspace } = await import('./service')
const { handleDesktopRepositoryTool } = await import('./handler')
import type { Command } from './git'

const repository = { owner: 'acme', name: 'tuner' }
let db: Client, dir: string, remote: string
const sh = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Sam', '-c', 'user.email=sam@example.test', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8' })
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repo-handler-'))
    db = createClient({ url: `file:${join(dir, 'app.db')}` })
    await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
    await initializeDesktopRound61(db)
    const seed = join(dir, 'seed'); remote = join(dir, 'remote.git')
    await mkdir(seed); await writeFile(join(seed, 'README.md'), '# Tuner\n')
    sh(seed, 'init', '--quiet', '-b', 'main'); sh(seed, 'add', '-A'); sh(seed, 'commit', '--quiet', '-m', 'first')
    execFileSync('/usr/bin/git', ['clone', '--quiet', '--bare', seed, remote])
})
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })

const identity = { agentId: 'engine-1', sessionId: 'chat-1', runId: 'run-1', toolCallId: 'call-1' }
function wired(gh: Command | null, repo: typeof repository | null = repository) {
    const authorize = vi.fn(async () => ({ coworker: { id: 'coworker-1', name: 'Tuner Developer' }, repository: repo }))
    return { authorize, ports: { authorize, db: async () => db, workspace: createRepositoryWorkspace({ root: join(dir, 'data'), git: fixtureGit, gh, remoteOf: () => remote }) } }
}
const call = async (ports: Parameters<typeof handleDesktopRepositoryTool>[1], tool: string, input: unknown = {}) =>
    (await handleDesktopRepositoryTool(new Request('http://127.0.0.1/api/desktop/internal/repository', { method: 'POST', body: JSON.stringify({ identity, tool, input }) }), ports)).json() as Promise<Record<string, unknown>>
const branches = () => sh(remote, 'branch', '--format=%(refname:short)').trim().split('\n')

it('publishes only after the person allows exactly what was shown, and asks again for the next one', async () => {
    const gh: Command = async () => ({ code: 0, stdout: 'https://github.com/acme/tuner/pull/9\n', stderr: '', cut: false })
    const { ports, authorize } = wired(gh)
    expect(await call(ports, 'repo_prepare', { topic: 'add notes' })).toMatchObject({ state: 'ready', branch: 'rerun/tuner-developer/add-notes' })
    expect(await call(ports, 'repo_write', { path: 'NOTES.md', content: 'first\n' })).toMatchObject({ written: true })
    const publish = { title: 'Add notes', body: 'Adds a notes file.' }

    const held = await call(ports, 'repo_publish', publish)
    expect(held).toMatchObject({ ok: false, asked: true })
    expect(String(held.note)).toContain('A card asking them is now in this chat')
    // Nothing left the Mac, and the card shows what would.
    expect(branches()).toEqual(['main'])
    const cards = (await readConnectorApprovals(db, 'chat-1')).pending
    expect(cards).toHaveLength(1)
    expect(JSON.stringify(cards[0])).toContain('rerun/tuner-developer/add-notes')
    expect(JSON.stringify(cards[0])).toContain('NOTES.md')
    // The fingerprint binds the answer but is not shown to the person.
    expect(JSON.stringify(cards[0])).not.toMatch(/changes|[a-f0-9]{64}/)
    // Asking again while the card waits does not publish either.
    expect(await call(ports, 'repo_publish', publish)).toMatchObject({ ok: false, asked: true })
    // This act never gets a standing answer.
    expect(await decideConnectorApproval(db, 'chat-1', cards[0]!.id, 'always')).toBeNull()
    expect(await decideConnectorApproval(db, 'chat-1', cards[0]!.id, 'once')).not.toBeNull()

    const before = authorize.mock.calls.length
    expect(await call(ports, 'repo_publish', publish)).toMatchObject({ published: true, pullRequest: 'https://github.com/acme/tuner/pull/9' })
    // The run's permission was checked again right before the push.
    expect(authorize.mock.calls.length).toBe(before + 2)
    expect(branches()).toEqual(['main', 'rerun/tuner-developer/add-notes'])

    // A further change is a new question: the earlier answer was spent and was for other changes.
    await call(ports, 'repo_write', { path: 'NOTES.md', content: 'second\n' })
    expect(await call(ports, 'repo_publish', publish)).toMatchObject({ ok: false, asked: true })
    expect(sh(remote, 'show', 'rerun/tuner-developer/add-notes:NOTES.md')).toBe('first\n')
})

it('a declined publish sends nothing, and a comment is asked about the same way', async () => {
    const sent: string[][] = []
    const gh: Command = async args => { sent.push([...args]); return { code: 0, stdout: '{"html_url":"https://github.com/acme/tuner/issues/3#issuecomment-1"}', stderr: '', cut: false } }
    const { ports } = wired(gh)
    await call(ports, 'repo_prepare', { topic: 'declined' })
    await call(ports, 'repo_write', { path: 'x.txt', content: 'x\n' })
    await call(ports, 'repo_publish', { title: 'X', body: 'x' })
    const [card] = (await readConnectorApprovals(db, 'chat-1')).pending
    await decideConnectorApproval(db, 'chat-1', card!.id, 'deny')
    const declined = await call(ports, 'repo_publish', { title: 'X', body: 'x' })
    expect(declined).toMatchObject({ ok: false, asked: true })
    expect(branches()).toEqual(['main'])

    expect(await call(ports, 'repo_comment', { number: 3, body: 'Looks right to me.' })).toMatchObject({ ok: false, asked: true })
    expect(sent).toEqual([])
    const comment = (await readConnectorApprovals(db, 'chat-1')).pending.find(row => JSON.stringify(row).includes('Looks right to me.'))!
    await decideConnectorApproval(db, 'chat-1', comment.id, 'once')
    expect(await call(ports, 'repo_comment', { number: 3, body: 'Looks right to me.' })).toEqual({ posted: true, comment: 'https://github.com/acme/tuner/issues/3#issuecomment-1' })
    expect(sent).toHaveLength(1)
})

it('refuses in plain words: no repository set, a bad argument, an unknown tool, a request that is not the engine\'s', async () => {
    expect(await call(wired(null, null).ports, 'repo_status')).toMatchObject({ ok: false, note: expect.stringContaining('No GitHub repository is set for you') })
    const { ports } = wired(null)
    expect(await call(ports, 'repo_read', { path: 42 })).toMatchObject({ ok: false, note: expect.stringContaining('were not understood') })
    expect(await call(ports, 'repo_merge')).toMatchObject({ ok: false })
    expect(await call(undefined, 'repo_status')).toMatchObject({ ok: false, note: expect.stringContaining('could not be done now') })
})
