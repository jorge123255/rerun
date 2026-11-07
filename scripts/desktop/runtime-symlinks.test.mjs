import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

test('accepts relative, absolute and chained links to contained bundled assets', async t => {
    const { resources } = await fixture(t)
    await symlink('runtime/asset.txt', join(resources, 'relative'))
    await symlink(join(resources, 'runtime', 'asset.txt'), join(resources, 'absolute'))
    await symlink('relative', join(resources, 'chain'))
    await symlink('runtime', join(resources, 'directory'))
    for (const name of ['relative', 'absolute', 'chain', 'directory']) {
        assert.equal(await runtimeSymlinkIsContained(resources, join(resources, name)), true, name)
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
