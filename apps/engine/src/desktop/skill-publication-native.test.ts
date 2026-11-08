import { spawn } from 'node:child_process'
import { link, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { acquireSkillLease } from './skill-publication-native.js'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'

// Source-only authoring: root's test execution compiles the exact helper and creates all fixtures.
let fixture: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
let root: string
const previous = process.env.RERUN_DESKTOP_RENAME_HELPER
type Reply = { ok: boolean; code?: string; dev?: string; ino?: string }
const children: { stop(): void; closed: Promise<number | null> }[] = []
beforeAll(async () => { fixture = await prepareSkillHelperFixture(); process.env.RERUN_DESKTOP_RENAME_HELPER = fixture.path }, 30_000)
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-native-skill-lock-'))) })
afterEach(async () => {
    for (const child of children) child.stop()
    await Promise.all(children.splice(0).map(child => child.closed))
    // Unlink the marker first so recursive removal cannot unlink two names of the same inode concurrently.
    await rm(join(root, '.rerun-skill-lock'), { force: true })
    await rm(root, { recursive: true, force: true })
})
afterAll(async () => {
    if (previous === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER
    else process.env.RERUN_DESKTOP_RENAME_HELPER = previous
    await fixture?.close()
})
function deadline<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Native skill-lock fixture did not finish')), 4000)
        work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
}
async function identity() { const stat = await lstat(root, { bigint: true }); return { dev: stat.dev, ino: stat.ino } }
async function launch(parent?: { dev: bigint; ino: bigint }) {
    const expected = parent ?? await identity()
    const child = spawn(fixture.path, ['--skill-lock', root, String(expected.dev), String(expected.ino)], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', replied = false
    const closed = new Promise<number | null>(resolve => { child.once('close', code => resolve(code)); child.once('error', () => resolve(null)) })
    const reply = new Promise<Reply>((resolve, reject) => {
        child.stdout.on('data', chunk => {
            output += String(chunk)
            if (output.length > 4096) { child.kill('SIGKILL'); reject(new Error('Oversized native reply')); return }
            if (replied || !output.includes('\n')) return
            replied = true
            try { resolve(JSON.parse(output.split('\n')[0])) } catch (error) { reject(error) }
        })
        child.once('error', reject)
        child.once('close', () => { if (!replied) reject(new Error('Native helper exited without a reply')) })
    })
    void reply.catch(() => {})
    child.stdin.on('error', () => {})
    child.stderr.resume()
    children.push({ stop: () => { child.stdin.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, closed })
    return { reply, closed, hasOutput: () => !!output, release: () => child.stdin.end(), kill: () => child.kill('SIGKILL') }
}

it('serializes two real processes on one persistent lock inode until the holder closes stdin', async () => {
    const holder = await launch(), admitted = await deadline(holder.reply)
    expect(admitted.ok).toBe(true)
    const lock = await lstat(join(root, '.rerun-skill-lock'), { bigint: true })
    expect(Number(lock.mode & BigInt(0o777))).toBe(0o600)
    expect(lock.nlink).toBe(BigInt(1))
    const waiter = await launch()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(waiter.hasOutput()).toBe(false)
    holder.release()
    expect(await deadline(holder.closed)).toBe(0)
    expect(await deadline(waiter.reply)).toEqual(admitted)
    waiter.release()
    expect(await deadline(waiter.closed)).toBe(0)
    expect((await lstat(join(root, '.rerun-skill-lock'), { bigint: true })).ino).toBe(lock.ino)
})

it('a killed holder releases the kernel lease without deleting or replacing its lock file', async () => {
    const holder = await launch(), admitted = await deadline(holder.reply)
    const waiter = await launch()
    holder.kill()
    await deadline(holder.closed)
    expect(await deadline(waiter.reply)).toEqual(admitted)
    waiter.release()
    expect(await deadline(waiter.closed)).toBe(0)
    expect(String((await lstat(join(root, '.rerun-skill-lock'), { bigint: true })).ino)).toBe(admitted.ino)
})

it('replacing the marker cannot split the directory lease between concurrent publishers', async () => {
    const holder = await launch()
    expect((await deadline(holder.reply)).ok).toBe(true)
    const marker = join(root, '.rerun-skill-lock')
    await rm(marker)
    await writeFile(marker, '', { mode: 0o600 })
    const waiter = await launch()
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(waiter.hasOutput()).toBe(false)
    holder.release()
    expect(await deadline(holder.closed)).toBe(0)
    expect((await deadline(waiter.reply)).ok).toBe(true)
    waiter.release()
    expect(await deadline(waiter.closed)).toBe(0)
})

it.each(['symlink', 'hardlink'] as const)('refuses a %s lock file without changing its target', async kind => {
    const target = join(root, 'untouched'), lock = join(root, '.rerun-skill-lock')
    await writeFile(target, 'Keep these bytes', { mode: 0o600 })
    if (kind === 'symlink') await symlink(target, lock)
    else await link(target, lock)
    const refused = await launch()
    expect((await deadline(refused.reply)).ok).toBe(false)
    expect(await deadline(refused.closed)).toBe(1)
    expect(await readFile(target, 'utf8')).toBe('Keep these bytes')
})

it('refuses a stale parent identity before creating a lock file', async () => {
    const parent = await identity()
    const refused = await launch({ ...parent, ino: parent.ino + BigInt(1) })
    expect(await deadline(refused.reply)).toEqual({ ok: false, code: 'ESTALE' })
    expect(await deadline(refused.closed)).toBe(1)
    await expect(lstat(join(root, '.rerun-skill-lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('an aborted queued adapter cannot acquire later after the holder releases', async () => {
    const holder = await launch()
    expect((await deadline(holder.reply)).ok).toBe(true)
    const stop = new AbortController()
    const pending = acquireSkillLease(root, await identity(), stop.signal).then(async lease => { await lease.release(); return { acquired: true } }, error => ({ error }))
    await new Promise(resolve => setTimeout(resolve, 150))
    stop.abort(new Error('Cancelled queued publication'))
    expect(await deadline(pending)).toMatchObject({ error: { message: 'Cancelled queued publication' } })
    holder.release()
    await deadline(holder.closed)
    const next = await deadline(acquireSkillLease(root, await identity()))
    try { expect(() => next.assertCurrent()).not.toThrow() } finally { await next.release() }
    expect(() => next.assertCurrent()).toThrow(/lock was lost/)
})
