import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { desktopWorkEvidenceFindings, desktopWorkObjectiveKey, desktopWorkSecretFindings } from '@rerun/contracts'

vi.mock('server-only', () => ({}))
const {
    closeDesktopWorkItem, isDesktopWorkNoticeKey, listDesktopWorkItems, listDesktopWorkNotices, noteDesktopWorkItem, readDesktopWorkNoticeEvents, upsertDesktopWorkItem,
} = await import('./store')
import type { DesktopWorkActor } from './store'

const roster = [{ id: 'a1', name: 'Tuner Developer' }, { id: 'a2', name: 'Server Developer' }]
const chief: DesktopWorkActor = { kind: 'chief' }
const tuner: DesktopWorkActor = { kind: 'coworker', agentId: 'a1', name: 'Tuner Developer' }
const server: DesktopWorkActor = { kind: 'coworker', agentId: 'a2', name: 'Server Developer' }
let dir: string, db: Client
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'rerun-work-')); db = createClient({ url: `file:${join(dir, 'w.db')}` }) })
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }) })
const count = async (table: string) => Number((await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]!.n)

test('an item keeps project, owner, objective, status, dependencies, blockers, next action, update, evidence, approval, source and revision', async () => {
    const dependency = (await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'tuner', objective: 'Ship the HDHomeRun probe', owner: 'Tuner Developer' })).item
    const { item, created } = await upsertDesktopWorkItem(db, '1', chief, roster, {
        project: 'tuner', owner: 'Server Developer', objective: 'Review the probe pull request', status: 'accepted', dependencies: [dependency.id],
        nextAction: 'Read the diff', update: 'Assigned after the 9:00 run', evidence: ['https://github.com/o/tuner/pull/7'], approvalRequired: 'Merge #7',
    })
    expect(created).toBe(true)
    expect(item).toMatchObject({
        project: 'tuner', owner: { kind: 'coworker', id: 'a2', name: 'Server Developer' }, objective: 'Review the probe pull request', status: 'accepted',
        dependencies: [dependency.id], nextAction: 'Read the diff', latestUpdate: { text: 'Assigned after the 9:00 run', by: 'Chief of Staff' },
        evidence: ['https://github.com/o/tuner/pull/7'], approval: { required: 'Merge #7', decides: 'person' }, source: { kind: 'chief', name: 'Chief of Staff' }, revision: 1,
    })
    const listed = await listDesktopWorkItems(db, '1', roster, { owner: 'server developer' })
    expect(listed.items.map(entry => entry.id)).toEqual([item.id])
    expect(listed.counts.accepted).toBe(1)
})

test('the duplicate guard: same words in any order, same project and owner, still open, returns the existing item', async () => {
    expect(desktopWorkObjectiveKey('Fix the login bug!')).toBe(desktopWorkObjectiveKey('login bug: fix'))
    expect(desktopWorkObjectiveKey('Fix the login bug on iOS')).not.toBe(desktopWorkObjectiveKey('Fix the login bug'))
    const first = (await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'Tuner', owner: 'Tuner Developer', objective: 'Fix the login bug' })).item
    const again = await upsertDesktopWorkItem(db, '1', chief, roster, { project: ' tuner ', owner: 'tuner developer', objective: 'login bug - FIX' })
    expect(again).toMatchObject({ created: false, duplicate: true, item: { id: first.id } })
    // Another owner, another project or other words are other work.
    expect((await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'Tuner', owner: 'Server Developer', objective: 'Fix the login bug' })).created).toBe(true)
    expect((await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'Server', owner: 'Tuner Developer', objective: 'Fix the login bug' })).created).toBe(true)
    expect((await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'Tuner', owner: 'Tuner Developer', objective: 'Fix the logout bug' })).created).toBe(true)
    // A closed item no longer covers the objective.
    await closeDesktopWorkItem(db, '1', roster, { id: first.id, expectedRevision: 1, status: 'done' })
    expect((await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'Tuner', owner: 'Tuner Developer', objective: 'Fix the login bug' })).created).toBe(true)
})

test('a coworker changes only items it owns or created, and cannot hand work to someone else', async () => {
    const theirs = (await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'server', owner: 'Server Developer', objective: 'Add the guide endpoint' })).item
    await expect(upsertDesktopWorkItem(db, '1', tuner, roster, { id: theirs.id, expectedRevision: 1, status: 'done' })).rejects.toMatchObject({ status: 403 })
    await expect(noteDesktopWorkItem(db, '1', tuner, roster, { id: theirs.id, update: 'I did it' })).rejects.toMatchObject({ status: 403 })
    await expect(upsertDesktopWorkItem(db, '1', tuner, roster, { project: 'tuner', objective: 'Probe', owner: 'Server Developer' })).rejects.toMatchObject({ status: 403 })
    // Its own: created without an owner, it owns it.
    const own = (await upsertDesktopWorkItem(db, '1', tuner, roster, { project: 'tuner', objective: 'Probe the tuner' })).item
    expect(own.owner).toMatchObject({ kind: 'coworker', id: 'a1' })
    expect((await upsertDesktopWorkItem(db, '1', tuner, roster, { id: own.id, expectedRevision: 1, status: 'working' })).item.revision).toBe(2)
    // The owner of an item the Chief of Staff assigned may change it.
    expect((await upsertDesktopWorkItem(db, '1', server, roster, { id: theirs.id, expectedRevision: 1, status: 'working', update: 'Started' })).item.status).toBe('working')
    // The Chief of Staff may change any item.
    expect((await noteDesktopWorkItem(db, '1', chief, roster, { id: own.id, update: 'Checked in' })).item.revision).toBe(3)
})

test('a write with an old revision is a conflict and changes nothing', async () => {
    const item = (await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'p', objective: 'Write the release notes' })).item
    await upsertDesktopWorkItem(db, '1', chief, roster, { id: item.id, expectedRevision: 1, nextAction: 'Draft' })
    await expect(upsertDesktopWorkItem(db, '1', chief, roster, { id: item.id, expectedRevision: 1, nextAction: 'Other' })).rejects.toMatchObject({ status: 409 })
    await expect(upsertDesktopWorkItem(db, '1', chief, roster, { id: item.id, nextAction: 'Other' })).rejects.toMatchObject({ status: 400 })
    const current = (await listDesktopWorkItems(db, '1', roster)).items[0]!
    expect(current).toMatchObject({ nextAction: 'Draft', revision: 2 })
    // A note appends without a revision, and still moves it on.
    expect((await noteDesktopWorkItem(db, '1', chief, roster, { id: item.id, evidence: ['docs/release.md'] })).item).toMatchObject({ revision: 3, evidence: ['docs/release.md'] })
    await expect(closeDesktopWorkItem(db, '1', roster, { id: item.id, expectedRevision: 2, status: 'dropped' })).rejects.toMatchObject({ status: 409 })
})

test('the register never stores a secret value or a reference to one', async () => {
    const secrets = [
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'use ${GITHUB_TOKEN} to push', 'Bearer abcdefghijklmnopqrstuvwxyz012345',
        'AKIAABCDEFGHIJKLMNOP', 'token glpat-abcdefghijklmnop1234', '-----BEGIN OPENSSH PRIVATE KEY-----',
    ]
    for (const secret of secrets) {
        expect(desktopWorkSecretFindings(secret).length, secret).toBeGreaterThan(0)
        await expect(upsertDesktopWorkItem(db, '1', chief, roster, { project: 'p', objective: 'Rotate keys', blockers: secret })).rejects.toMatchObject({ status: 400 })
        await expect(upsertDesktopWorkItem(db, '1', chief, roster, { project: 'p', objective: `Use ${secret}` })).rejects.toMatchObject({ status: 400 })
    }
    for (const evidence of ['https://x.test/run?token=abc', 'https://user:hunter2@git.test/repo', '.env.production', 'keys/deploy.pem']) {
        expect(desktopWorkEvidenceFindings(evidence).length, evidence).toBeGreaterThan(0)
        await expect(upsertDesktopWorkItem(db, '1', chief, roster, { project: 'p', objective: 'Rotate keys', evidence: [evidence] })).rejects.toMatchObject({ status: 400 })
    }
    expect(await count('desktop_work_items')).toBe(0)
    // Ordinary links and paths are evidence.
    const item = (await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'p', objective: 'Rotate keys', evidence: ['https://github.com/o/r/pull/3', 'docs/rotation.md'] })).item
    await expect(noteDesktopWorkItem(db, '1', chief, roster, { id: item.id, update: 'the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123' })).rejects.toMatchObject({ status: 400 })
    expect((await listDesktopWorkItems(db, '1', roster)).items[0]!.revision).toBe(1)
})

test('what needs the person becomes one notice each; an ordinary blocker does not', async () => {
    const item = (await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'server', objective: 'Deploy 2.4 to production', approvalRequired: 'Deploy 2.4 to production' })).item
    expect(item.status).toBe('waiting_approval')
    await noteDesktopWorkItem(db, '1', chief, roster, { id: item.id, update: 'Still waiting' })
    await upsertDesktopWorkItem(db, '1', chief, roster, { id: item.id, expectedRevision: 2, approvalRequired: 'Deploy 2.4 to production' })
    const blocked = (await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'server', objective: 'Fix flaky tests', status: 'blocked', blockers: 'CI runner offline' })).item
    expect((await listDesktopWorkNotices(db, '1')).map(notice => notice.kind)).toEqual(['approval'])
    await upsertDesktopWorkItem(db, '1', chief, roster, { id: blocked.id, expectedRevision: 1, important: true })
    const notices = await listDesktopWorkNotices(db, '1')
    expect(notices.map(notice => notice.kind).sort()).toEqual(['approval', 'blocker'])
    const events = await readDesktopWorkNoticeEvents(db, '1')
    expect(events).toHaveLength(2)
    expect(events.every(entry => isDesktopWorkNoticeKey(entry.event.key) && entry.event.agentId === 'foreman' && entry.event.kind === 'approval')).toBe(true)
    // Closing the item settles what it asked for.
    await closeDesktopWorkItem(db, '1', roster, { id: item.id, expectedRevision: 3, status: 'dropped' })
    expect((await listDesktopWorkNotices(db, '1')).map(notice => notice.kind)).toEqual(['blocker'])
})

test('the person cannot write items through the tools\' path, and owners name real coworkers only', async () => {
    await expect(upsertDesktopWorkItem(db, '1', { kind: 'person' }, roster, { project: 'p', objective: 'o' })).rejects.toMatchObject({ status: 403 })
    await expect(upsertDesktopWorkItem(db, '1', chief, roster, { project: 'p', objective: 'o', owner: 'Nobody' })).rejects.toMatchObject({ status: 400 })
    expect((await upsertDesktopWorkItem(db, '1', chief, roster, { project: 'p', objective: 'Decide pricing', owner: 'person' })).item.owner).toMatchObject({ kind: 'person', name: 'You' })
})
