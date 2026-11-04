import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const supported = process.platform === 'darwin' || process.platform === 'linux'
const source = fileURLToPath(new URL('../../apps/desktop/native/rename-entry.c', import.meta.url))
const production = process.env.RERUN_DESKTOP_RENAME_HELPER || fileURLToPath(new URL('../../apps/desktop/resources/runtime/helpers/rerun-rename-entry', import.meta.url))
let root, instrumented
before(async () => {
    if (!supported) return
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-native-rename-')))
    instrumented = join(root, 'rename-entry-testing')
    // Only this disposable test binary contains the rendezvous barriers; staging compiles
    // without RERUN_RENAME_TESTING and never invokes a compiler from the installed app.
    const args = ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', '-DRERUN_RENAME_TESTING', source, '-o', instrumented]
    await exec(process.platform === 'darwin' ? '/usr/bin/xcrun' : '/usr/bin/cc', process.platform === 'darwin' ? ['clang', ...args] : args)
})
after(async () => { if (root) await rm(root, { recursive: true, force: true }) })

async function fixture() {
    const directory = await mkdtemp(join(root, 'case-'))
    await writeFile(join(directory, 'notes.md'), 'Original bytes')
    return directory
}
async function argsFor(directory, from = 'notes.md', to = 'renamed.md') {
    const parent = await lstat(directory, { bigint: true }), source = await lstat(join(directory, from), { bigint: true })
    return [directory, String(parent.dev), String(parent.ino), from, String(source.dev), String(source.ino), to]
}
async function invoke(binary, args) {
    let output
    try { output = (await exec(binary, args, { timeout: 10000 })).stdout }
    catch (error) { if (!error.stdout) throw error; output = error.stdout }
    return JSON.parse(output)
}
async function race(args, onPhase) {
    const child = spawn(instrumented, args, { env: { ...process.env, RERUN_RENAME_TEST_BARRIERS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', pending = '', chain = Promise.resolve(), failure
    const timer = setTimeout(() => { failure = new Error('Native rename barrier timed out'); child.kill('SIGKILL') }, 10000)
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', value => { stdout += value })
    child.stderr.on('data', value => {
        pending += value
        let newline
        while ((newline = pending.indexOf('\n')) !== -1) {
            const phase = pending.slice(0, newline); pending = pending.slice(newline + 1)
            chain = chain.then(async () => { await onPhase(phase); child.stdin.write('\n') }).catch(error => { failure = error; child.kill('SIGKILL') })
        }
    })
    try {
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
        await chain
        if (failure) throw failure
        return JSON.parse(stdout)
    } finally { clearTimeout(timer) }
}

test('bundled helper renames a file and a directory using only the selected parent', { skip: !supported }, async () => {
    const directory = await fixture(), original = await lstat(join(directory, 'notes.md'), { bigint: true })
    assert.deepEqual(await invoke(production, await argsFor(directory)), { ok: true })
    assert.equal(await readFile(join(directory, 'renamed.md'), 'utf8'), 'Original bytes')
    assert.equal((await lstat(join(directory, 'renamed.md'), { bigint: true })).ino, original.ino)
    await mkdir(join(directory, 'folder'))
    await writeFile(join(directory, 'folder', 'child.md'), 'Child bytes')
    assert.deepEqual(await invoke(production, await argsFor(directory, 'folder', 'other-folder')), { ok: true })
    assert.equal(await readFile(join(directory, 'other-folder', 'child.md'), 'utf8'), 'Child bytes')
})

test('existing destinations, symlinks, stale identities and non-simple names never replace bytes', { skip: !supported }, async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'renamed.md'), 'Destination winner')
    assert.deepEqual(await invoke(production, await argsFor(directory)), { ok: false, code: 'EEXIST' })
    const stale = await argsFor(directory, 'notes.md', 'fresh.md'); stale[5] = String(BigInt(stale[5]) + 1n)
    assert.deepEqual(await invoke(production, stale), { ok: false, code: 'ESTALE' })
    const traversal = await argsFor(directory); traversal[6] = '../outside.md'
    assert.deepEqual(await invoke(production, traversal), { ok: false, code: 'EINVAL' })
    await symlink(join(directory, 'renamed.md'), join(directory, 'link.md'))
    assert.deepEqual(await invoke(production, await argsFor(directory, 'link.md', 'fresh.md')), { ok: false, code: 'ESTALE' })
    assert.equal(await readFile(join(directory, 'notes.md'), 'utf8'), 'Original bytes')
    assert.equal(await readFile(join(directory, 'renamed.md'), 'utf8'), 'Destination winner')
})

test('exclusive rename protects a destination arriving after the native checks', { skip: !supported }, async () => {
    const directory = await fixture()
    const result = await race(await argsFor(directory), async phase => {
        assert.equal(phase, 'before-rename')
        await writeFile(join(directory, 'renamed.md'), 'Late destination')
    })
    assert.deepEqual(result, { ok: false, code: 'EEXIST' })
    assert.equal(await readFile(join(directory, 'notes.md'), 'utf8'), 'Original bytes')
    assert.equal(await readFile(join(directory, 'renamed.md'), 'utf8'), 'Late destination')
})

test('a source replaced after native preflight is restored using the inode actually moved', { skip: !supported }, async () => {
    const directory = await fixture(), phases = []
    const result = await race(await argsFor(directory), async phase => {
        phases.push(phase)
        if (phase !== 'before-rename') return
        await rename(join(directory, 'notes.md'), join(directory, 'original-kept.md'))
        await writeFile(join(directory, 'notes.md'), 'Atomic writer replacement')
    })
    assert.deepEqual(phases, ['before-rename', 'before-rollback'])
    assert.deepEqual(result, { ok: false, code: 'ESTALE' })
    assert.equal(await readFile(join(directory, 'notes.md'), 'utf8'), 'Atomic writer replacement')
    assert.equal(await readFile(join(directory, 'original-kept.md'), 'utf8'), 'Original bytes')
    assert.equal((await readdir(directory)).includes('renamed.md'), false)
})

test('a source arrival during rollback is preserved along with both previous versions', { skip: !supported }, async () => {
    const directory = await fixture()
    const result = await race(await argsFor(directory), async phase => {
        if (phase === 'before-rename') {
            await rename(join(directory, 'notes.md'), join(directory, 'original-kept.md'))
            await writeFile(join(directory, 'notes.md'), 'Replacement caught by rename')
        } else {
            assert.equal(phase, 'before-rollback')
            await writeFile(join(directory, 'notes.md'), 'Newest source arrival')
        }
    })
    assert.deepEqual(result, { ok: false, code: 'ESTALE' })
    assert.equal(await readFile(join(directory, 'notes.md'), 'utf8'), 'Newest source arrival')
    assert.equal(await readFile(join(directory, 'renamed.md'), 'utf8'), 'Replacement caught by rename')
    assert.equal(await readFile(join(directory, 'original-kept.md'), 'utf8'), 'Original bytes')
})

test('a parent moved after native admission restores the old name and does not mutate the replacement parent', { skip: !supported }, async () => {
    const directory = await fixture(), moved = directory + '-other-owner'
    const result = await race(await argsFor(directory), async phase => {
        if (phase !== 'before-rename') return
        await rename(directory, moved)
        await mkdir(directory)
        await writeFile(join(directory, 'notes.md'), 'Other owner at original path')
    })
    assert.deepEqual(result, { ok: false, code: 'ESTALE' })
    assert.equal(await readFile(join(directory, 'notes.md'), 'utf8'), 'Other owner at original path')
    assert.equal(await readFile(join(moved, 'notes.md'), 'utf8'), 'Original bytes')
    assert.equal((await readdir(moved)).includes('renamed.md'), false)
})
