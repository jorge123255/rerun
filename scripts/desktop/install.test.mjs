import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleName, electronAsar, installPreview, verifyBundle } from './install.mjs'
import { macTarget } from './mac-target.mjs'

const macTest = process.platform === 'darwin' ? test : test.skip
const { arch, appDirectory } = macTarget()
const A = { protocolVersion: 1, sourceCommit: 'a'.repeat(40), buildId: 'aaaaaaa-desktop-0.1.0', arch }
const B = { ...A, sourceCommit: 'b'.repeat(40), buildId: 'bbbbbbb-desktop-0.1.0' }
const id = 'build.rerun.desktop.preview'

function plist(identity) {
    return `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identity}</string></dict></plist>`
}

async function fixture(t) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-install-test-')))
    t.after(() => rm(root, { recursive: true, force: true }))
    const applications = join(root, 'Applications'), target = join(applications, bundleName)
    const asar = electronAsar()
    async function build(out, stamp, { bad, identity = id } = {}) {
        const bundle = join(out, appDirectory, bundleName)
        const resources = join(bundle, 'Contents/Resources')
        const shell = await mkdtemp(join(root, 'test-shell-'))
        await mkdir(join(shell, 'dist/main'), { recursive: true })
        await writeFile(join(shell, 'dist/main/desktop-build.json'), JSON.stringify(bad === 'shell' ? A : stamp))
        await mkdir(resources, { recursive: true })
        await asar.createPackage(shell, join(resources, 'app.asar'))
        await writeFile(join(bundle, 'Contents/Info.plist'), plist(identity))
        await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify(bad === 'manifest' ? A : stamp))
        for (const part of ['ui', 'engine']) {
            const path = join(resources, 'runtime', part)
            await mkdir(path, { recursive: true })
            await writeFile(join(path, 'desktop-build.json'), JSON.stringify(bad === part ? A : stamp))
        }
        return bundle
    }
    async function install(stamp, options = {}) {
        return installPreview({ applications, stampOfSource: async () => stamp, requireQuit: async () => {},
            build: out => build(out, stamp), ...options })
    }
    const stages = () => readdir(join(applications, '.rerun-desktop-install.noindex'))
    return { applications, target, root, install, build, stages }
}

macTest('fresh install, repeat and atomic upgrade leave one app and no backup bundle', async t => {
    const f = await fixture(t)
    assert.deepEqual(await f.install(A, { commit: A.sourceCommit }), { destination: f.target, commit: A.sourceCommit })
    await verifyBundle(f.target, A)
    const stale = join(f.applications, '.rerun-desktop-install.noindex/build', appDirectory, 'old.app')
    await mkdir(stale, { recursive: true })
    await f.install(B)
    await verifyBundle(f.target, B)
    await f.install(B)
    assert.deepEqual(await f.stages(), ['install.lock'])
    assert.deepEqual((await readdir(f.applications)).filter(name => name.endsWith('.app')), [bundleName])
})

macTest('a mismatched packaged receipt or bundle identity never replaces the installed app', async t => {
    const f = await fixture(t)
    await f.install(A)
    for (const bad of ['manifest', 'shell', 'ui', 'engine']) {
        await assert.rejects(f.install(B, { build: out => f.build(out, B, { bad }) }), /receipt does not match/)
        await verifyBundle(f.target, A)
    }
    const otherArch = arch === 'arm64' ? 'x64' : 'arm64'
    await assert.rejects(f.install(B, { build: out => f.build(out, { ...B, arch: otherArch }) }), /receipt does not match/)
    await verifyBundle(f.target, A)
    await assert.rejects(f.install(B, { build: out => f.build(out, B, { identity: 'some.other.app' }) }), /bundle ID/)
    assert.deepEqual(await f.stages(), ['install.lock'])
})

macTest('source drift, quit check, build and swap failures preserve the original app', async t => {
    const f = await fixture(t)
    await f.install(A)
    let builds = 0, checks = 0, quits = 0
    await assert.rejects(f.install(B, { commit: A.sourceCommit, build: () => { builds++ } }), /requested commit/)
    await assert.rejects(f.install(B, { requireQuit: async () => { throw new Error('still open') }, build: () => { builds++ } }), /still open/)
    assert.equal(builds, 0)
    await assert.rejects(f.install(B, { stampOfSource: async () => ++checks === 1 ? B : A }), /source changed/)
    await assert.rejects(f.install(B, { requireQuit: async () => { if (++quits === 2) throw new Error('opened during build') } }), /opened during build/)
    await assert.rejects(f.install(B, { build: async () => { throw new Error('build failed') } }), /build failed/)
    await assert.rejects(f.install(B, { publishApp: async () => { throw new Error('swap failed') } }), /swap failed/)
    await verifyBundle(f.target, A)
    assert.deepEqual(await f.stages(), ['install.lock'])
})

macTest('concurrent installs cannot remove each other’s staging output', async t => {
    const f = await fixture(t)
    let reached, finish
    const started = new Promise(done => { reached = done })
    const hold = new Promise(done => { finish = done })
    const first = f.install(A, { build: async out => {
        await f.build(out, A)
        reached()
        await hold
        await access(join(out, appDirectory, bundleName))
    } })
    try {
        await started
        await assert.rejects(f.install(B), /in progress/)
    } finally { finish(); await first }
    await verifyBundle(f.target, A)
})

macTest('refuses a foreign app or symlink destination even if it appears during the build', async t => {
    const f = await fixture(t)
    await f.install(A)
    const info = join(f.target, 'Contents/Info.plist')
    await writeFile(info, plist('other.app'))
    await assert.rejects(f.install(B), /bundle ID/)
    assert.equal(await readFile(info, 'utf8'), plist('other.app'))
    await rm(f.target, { recursive: true })
    await symlink(f.root, f.target)
    await assert.rejects(f.install(B), /linked or invalid/)
    await rm(f.target)
    await assert.rejects(f.install(B, { build: async out => {
        await f.build(out, B)
        await mkdir(f.target)
        await writeFile(join(f.target, 'keep'), 'foreign')
    } }))
    assert.equal(await readFile(join(f.target, 'keep'), 'utf8'), 'foreign')
})

macTest('disk image installation requires pinned input and preserves the installed app on verification failure', async t => {
    const f = await fixture(t)
    await f.install(A)
    const image = join(f.root, 'candidate.dmg')
    const bundle = await f.build(join(f.root, 'image-source'), B)
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', join(bundle, '..'), '-format', 'UDZO', image])
    const sha256 = createHash('sha256').update(await readFile(image)).digest('hex')
    const options = { image, commit: B.sourceCommit, sha256 }
    await assert.rejects(f.install(undefined, { ...options, commit: undefined }), /requires --commit/)
    await assert.rejects(f.install(undefined, { ...options, sha256: '0'.repeat(64) }), /SHA-256 does not match/)
    const stagedImage = join(f.applications, '.rerun-desktop-install.noindex', 'in-use.dmg')
    await writeFile(stagedImage, 'keep')
    await assert.rejects(f.install(undefined, { ...options, image: stagedImage }), /outside the preview installer/)
    assert.equal(await readFile(stagedImage, 'utf8'), 'keep')
    await rm(stagedImage)
    await verifyBundle(f.target, A)

    await rm(f.target, { recursive: true })
    await assert.rejects(f.install(undefined, options), /codesign.*exited/)
    await assert.rejects(access(f.target), { code: 'ENOENT' })
    assert.deepEqual(await f.stages(), ['install.lock'])
})
