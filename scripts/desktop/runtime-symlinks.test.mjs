import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runtimeSymlinkIsContained } from './runtime-symlinks.mjs'

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'rerun-runtime-symlinks-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const resources = join(root, 'Resources')
    await mkdir(join(resources, 'runtime'), { recursive: true })
    await writeFile(join(resources, 'runtime', 'asset.txt'), 'bundled fixture')
    await mkdir(join(root, 'Resources-sibling'))
    await writeFile(join(root, 'Resources-sibling', 'asset.txt'), 'outside fixture')
    return { root, resources }
}

test('accepts relative and chained links to contained bundled assets', async t => {
    const { resources } = await fixture(t)
    await symlink('runtime/asset.txt', join(resources, 'relative'))
    await symlink('relative', join(resources, 'chain'))
    await symlink('runtime', join(resources, 'directory'))
    for (const name of ['relative', 'chain', 'directory']) {
        assert.equal(await runtimeSymlinkIsContained(resources, join(resources, name)), true, name)
    }
})

test('rejects links that depend on the staging root name or absolute location', async t => {
    const { resources } = await fixture(t)
    await symlink(join(resources, 'runtime', 'asset.txt'), join(resources, 'absolute'))
    await symlink('../Resources/runtime/asset.txt', join(resources, 'leaves-and-returns'))
    for (const name of ['absolute', 'leaves-and-returns']) {
        assert.equal(await runtimeSymlinkIsContained(resources, join(resources, name)), false, name)
    }
})

test('rejects a link resolving exactly to the Resources parent', async t => {
    const { resources } = await fixture(t)
    const link = join(resources, 'parent')
    await symlink('..', link)
    assert.equal(await runtimeSymlinkIsContained(resources, link), false)
})

test('rejects outside files and directories, including a sibling sharing the Resources prefix', async t => {
    const { root, resources } = await fixture(t)
    await symlink(join(root, 'Resources-sibling', 'asset.txt'), join(resources, 'outside-file'))
    await symlink('../Resources-sibling', join(resources, 'outside-directory'))
    await symlink('../outside-directory/asset.txt', join(resources, 'runtime', 'outside-chain'))
    for (const path of ['outside-file', 'outside-directory', 'runtime/outside-chain']) {
        assert.equal(await runtimeSymlinkIsContained(resources, join(resources, path)), false, path)
    }
})

test('rejects broken direct links and broken link chains', async t => {
    const { resources } = await fixture(t)
    await symlink('runtime/missing.txt', join(resources, 'broken'))
    await symlink('broken', join(resources, 'broken-chain'))
    for (const name of ['broken', 'broken-chain']) {
        assert.equal(await runtimeSymlinkIsContained(resources, join(resources, name)), false, name)
    }
})

test('rejects an unresolved symlink cycle without following it indefinitely', async t => {
    const { resources } = await fixture(t)
    await symlink('cycle-b', join(resources, 'cycle-a'))
    await symlink('cycle-a', join(resources, 'cycle-b'))
    assert.equal(await runtimeSymlinkIsContained(resources, join(resources, 'cycle-a')), false)
})

for (const kind of ['absolute executable', 'escaping dependency link']) {
    test(`verification refuses an ${kind} before probing the bundle`, async t => {
        const { root, resources } = await fixture(t)
        const marker = join(root, 'probed')
        const runtime = join(resources, 'runtime')
        const engine = join(runtime, 'engine', 'dist', 'cli')
        const ui = join(runtime, 'ui')
        await mkdir(engine, { recursive: true })
        await mkdir(join(ui, '.next', 'static'), { recursive: true })
        await mkdir(join(ui, 'public'))
        await mkdir(join(runtime, 'node', 'bin'), { recursive: true })
        await writeFile(join(runtime, 'node', 'bin', 'npm'), 'fixture')
        await writeFile(join(engine, 'bin.js'), 'fixture')
        await writeFile(join(ui, 'server.js'), 'fixture')
        if (kind === 'escaping dependency link') {
            await symlink('../Resources-sibling/asset.txt', join(resources, 'external'))
        }
        const asset = 'runtime/asset.txt'
        await writeFile(join(resources, 'runtime-manifest.json'), JSON.stringify({
            protocolVersion: 1, buildId: 'fixture', nodePath: kind === 'absolute executable' ? join(root, 'Resources-sibling', 'asset.txt') : asset,
            engineEntry: 'runtime/engine/dist/cli/bin.js', uiRoot: 'runtime/ui', uiHost: asset, codexPath: asset,
            claudePath: asset, claudeSandboxPath: asset, renameHelperPath: asset, pdfHelperPath: asset, pdfTextHelperPath: asset,
        }))
        const stub = `import {writeFileSync} from 'node:fs';
            export {existsSync} from 'node:fs';
            export const resourcesDir=${JSON.stringify(resources)}, repoRoot=${JSON.stringify(root)};
            export const output=async()=>{writeFileSync(${JSON.stringify(marker)}, 'probe ran'); return 'v22.23.4'};`
        const loader = join(root, 'loader.mjs')
        await writeFile(loader, `export async function load(url, context, next) {
            if (url === ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)}) return {format:'module', shortCircuit:true, source:${JSON.stringify(stub)}};
            return next(url, context);
        }`)
        assert.throws(() => execFileSync(process.execPath, ['--loader', loader, fileURLToPath(new URL('./verify-runtime.mjs', import.meta.url))], { stdio: 'pipe', timeout: 15_000 }),
            error => error.status === 1)
        assert.equal(existsSync(marker), false, 'the probe ran before the bundle was refused')
    })
}
