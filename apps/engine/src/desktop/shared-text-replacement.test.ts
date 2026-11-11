import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'
import { readSharedText, replaceSharedText } from './shared-workspace-files.js'

const exec = promisify(execFile)
const xattr = '/usr/bin/xattr'
const metadataKey = 'com.rerun.fixture'

describe.skipIf(process.platform !== 'darwin')('Mac shared text replacement', () => {
    let scratch = '', shared = ''
    let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
    const previousHelper = process.env.RERUN_DESKTOP_RENAME_HELPER
    beforeAll(async () => {
        helper = await prepareSkillHelperFixture(true)
        process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path
        scratch = await realpath(await mkdtemp(join(tmpdir(), 'rerun-shared-replace-')))
        shared = join(scratch, 'workspaces', '1', 'engine', 'shared')
        await mkdir(shared, { recursive: true })
    })
    afterAll(async () => {
        if (previousHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER
        else process.env.RERUN_DESKTOP_RENAME_HELPER = previousHelper
        await helper?.close()
        if (scratch) await rm(scratch, { recursive: true, force: true })
    })

    test('preserves ACL, xattr, ownership and mode while publishing UTF-8 and retaining the displaced inode', async () => {
        const path = 'metadata.md', target = join(shared, path), original = '\ufefforiginal\r\n'
        await writeFile(target, original)
        await chmod(target, 0o640)
        await exec('/bin/chmod', ['+a', 'everyone allow read', target])
        await exec(xattr, ['-w', metadataKey, 'fixture metadata', target])
        const acl = async (file: string) => (await exec('/bin/ls', ['-le', file])).stdout.split('\n').slice(1).join('\n')
        const originalAcl = await acl(target)
        expect(originalAcl).toContain('everyone allow read')
        const identity = (await readSharedText(shared, path)).editIdentity!
        const prior = await lstat(target, { bigint: true })
        const content = '\ufeffupdated – 新しい\r\n'
        const saved = await replaceSharedText(shared, { path, content, ...identity })
        expect(saved).toMatchObject({ ok: true, path, size: Buffer.byteLength(content) })
        expect(await readFile(target, 'utf8')).toBe(content)
        expect((await readSharedText(shared, path)).editIdentity).toEqual(saved.editIdentity)
        const recovery = join(shared, saved.recoveryPath!)
        expect(await readFile(recovery, 'utf8')).toBe(original)
        const after = await lstat(target, { bigint: true })
        expect(after).toMatchObject({ mode: prior.mode, uid: prior.uid, gid: prior.gid, nlink: 1n })
        expect(after.ino).not.toBe(prior.ino)
        expect((await lstat(recovery, { bigint: true })).ino).toBe(prior.ino)
        expect(await acl(target)).toBe(originalAcl)
        expect((await exec(xattr, ['-p', metadataKey, target])).stdout).toBe('fixture metadata\n')
    })

    test('serializes same-base saves and refuses stale, linked and non-UTF-8 files', async () => {
        const path = 'concurrent.md', target = join(shared, path)
        await writeFile(target, 'initial')
        const identity = (await readSharedText(shared, path)).editIdentity!
        const outcomes = await Promise.allSettled([
            replaceSharedText(shared, { path, content: 'first contender', ...identity }),
            replaceSharedText(shared, { path, content: 'second contender', ...identity }),
        ])
        const saved = outcomes.filter(outcome => outcome.status === 'fulfilled')
        expect(saved).toHaveLength(1)
        expect(outcomes.find(outcome => outcome.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
        expect((await readSharedText(shared, path)).editIdentity).toEqual(saved[0]!.value.editIdentity)
        expect(await readFile(join(shared, saved[0]!.value.recoveryPath!), 'utf8')).toBe('initial')
        const before = await readdir(shared)
        await expect(replaceSharedText(shared, { path, content: 'stale', ...identity })).rejects.toMatchObject({ status: 409 })
        expect(await readdir(shared)).toEqual(before)
        const linkName = 'alias.md', hardLink = 'hardlink.md'
        await symlink(target, join(shared, linkName))
        await link(target, join(shared, hardLink))
        for (const candidate of [linkName, hardLink, path]) {
            await expect(replaceSharedText(shared, { path: candidate, content: 'unsafe', ...identity })).rejects.toMatchObject({ status: 400 })
        }
        await writeFile(join(shared, 'binary.md'), Buffer.from([0xff]))
        await expect(replaceSharedText(shared, { path: 'binary.md', content: 'unsafe', ...identity })).rejects.toMatchObject({ status: 415 })
    })

    test('preserves an external arrival after the final native check and reports an uncertain save', async () => {
        const stage = '.rerun-shared-replace-fixture', target = 'race.md', recovery = 'shared-edit-recovery-fixture.md'
        await writeFile(join(shared, stage), 'edited bytes')
        await writeFile(join(shared, target), 'original bytes')
        const [folder, original, staged] = await Promise.all([shared, join(shared, target), join(shared, stage)].map(path => lstat(path, { bigint: true })))
        const child = spawn(helper.path, ['--replace-shared-text', shared, String(folder.dev), String(folder.ino), stage, String(staged.dev),
            String(staged.ino), target, String(original.dev), String(original.ino), String(original.size),
            String(original.ctimeNs / 1_000_000_000n), String(original.ctimeNs % 1_000_000_000n), recovery],
        { env: { ...process.env, RERUN_RENAME_TEST_BARRIERS: '1' } })
        const closed = once(child, 'close')
        let output = ''
        child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
        try {
            const marker = await Promise.race([
                once(child.stderr, 'data').then(([chunk]) => String(chunk)),
                closed.then(() => { throw new Error(`Native helper exited before publication: ${output}`) }),
            ])
            expect(marker.trim()).toBe('before-shared-swap')
            await rename(join(shared, target), join(shared, 'external-original.md'))
            await writeFile(join(shared, target), 'external arrival')
            child.stdin.end('\n')
            expect((await closed)[0]).toBe(1)
            expect(JSON.parse(output)).toEqual({ ok: false, code: 'ESTALE', beforeSwap: false })
            expect(await readFile(join(shared, target), 'utf8')).toBe('edited bytes')
            expect(await readFile(join(shared, recovery), 'utf8')).toBe('external arrival')
            expect(await readFile(join(shared, 'external-original.md'), 'utf8')).toBe('original bytes')
        } finally {
            child.stdin.end()
            await closed
        }
    })
})
