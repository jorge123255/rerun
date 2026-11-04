import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { readUiSharpManifest, stageUiSharp, UI_SHARP_MANIFEST } from './ui-sharp.mjs'

const native = '@img/sharp-darwin-arm64'
const vips = '@img/sharp-libvips-darwin-arm64'
const alias = 'sharp-3cc85dba944d79bb'

async function write(path, value) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, value)
}
async function link(path, target) {
    await mkdir(dirname(path), { recursive: true })
    await rm(path, { recursive: true, force: true })
    await symlink(relative(dirname(path), target), path)
}
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'rerun-ui-sharp-'))
    const repo = join(root, 'repo'), uiDir = join(repo, 'apps/ui'), sourceNodeModules = join(repo, 'node_modules')
    const uiRoot = join(root, 'stage/ui')
    const packagePath = (name, version) => join(sourceNodeModules, '.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name)
    const sharp = packagePath('sharp', '0.35.1'), addon = packagePath(native, '0.35.1'), libvips = packagePath(vips, '1.3.0')
    const js = packagePath('runtime-helper', '2.1.2')
    await write(join(uiDir, 'package.json'), JSON.stringify({ name: 'ui', dependencies: { sharp: '^0.35.1' } }))
    const packages = [
        [sharp, { name: 'sharp', version: '0.35.1', dependencies: { 'runtime-helper': '^2.1.2' }, optionalDependencies: { [native]: '0.35.1', [vips]: '1.3.0', '@img/sharp-win32-x64': '0.35.1' } }],
        [addon, { name: native, version: '0.35.1', exports: { './package': './package.json' }, optionalDependencies: { [vips]: '1.3.0' } }],
        [libvips, { name: vips, version: '1.3.0', exports: { './package': './package.json' } }],
        [js, { name: 'runtime-helper', version: '2.1.2' }],
    ]
    for (const [path, pkg] of packages) await write(join(path, 'package.json'), JSON.stringify(pkg))
    await write(join(sharp, 'dist/index.cjs'), 'fixture Sharp runtime')
    await write(join(addon, 'lib/sharp-darwin-arm64-0.35.1.node'), 'fixture native addon')
    await write(join(libvips, 'lib/libvips-cpp.8.18.3.dylib'), 'fixture matching native library')
    await write(join(js, 'index.js'), 'fixture JS dependency')
    await link(join(uiDir, 'node_modules/sharp'), sharp)
    for (const [name, target] of [[native, addon], [vips, libvips], ['runtime-helper', js]]) {
        await link(join(dirname(sharp), name), target)
    }
    await link(join(dirname(dirname(addon)), vips), libvips)

    const mirror = path => join(uiRoot, 'node_modules', relative(sourceNodeModules, path))
    // Reproduce Next's incomplete native trace: package metadata and addon exist, but the
    // matching libvips payload and the addon's adjacent @img/libvips link are absent.
    for (const path of [sharp, addon, libvips]) await write(join(mirror(path), 'package.json'), await readFile(join(path, 'package.json')))
    await cp(join(addon, 'lib'), join(mirror(addon), 'lib'), { recursive: true })
    await link(join(uiRoot, '.next/node_modules', alias), mirror(sharp))
    // A different bundled Sharp version must not be selected just because it is available.
    await write(join(uiRoot, 'node_modules/.pnpm/sharp@0.34.5/node_modules/sharp/package.json'), JSON.stringify({ name: 'sharp', version: '0.34.5' }))
    return { root, repo, uiDir, uiRoot, sourceNodeModules, sharp, addon, libvips, js, mirror,
        options: { uiDir, uiRoot, sourceNodeModules } }
}

test('repairs the partial UI native trace with complete exact-version packages and adjacent links', async () => {
    const f = await fixture()
    try {
        const library = join(f.mirror(f.libvips), 'lib/libvips-cpp.8.18.3.dylib')
        const adjacent = join(dirname(dirname(f.mirror(f.addon))), vips)
        assert.equal(existsSync(library), false)
        assert.equal(existsSync(adjacent), false)
        const manifest = await stageUiSharp(f.options)
        assert.equal(manifest.version, '0.35.1')
        assert.deepEqual(manifest.aliases, [alias])
        assert.deepEqual(manifest.packages.map(pkg => `${pkg.name}@${pkg.version}`).sort(),
            ['sharp@0.35.1', `${native}@0.35.1`, `${vips}@1.3.0`, 'runtime-helper@2.1.2'].sort())
        assert.equal(await readFile(library, 'utf8'), 'fixture matching native library')
        assert.equal(await realpath(adjacent), await realpath(f.mirror(f.libvips)))
        assert.equal(await realpath(join(dirname(f.mirror(f.sharp)), native)), await realpath(f.mirror(f.addon)))
        assert.equal(await readFile(join(f.mirror(f.js), 'index.js'), 'utf8'), 'fixture JS dependency')
        assert.equal(await realpath(join(f.uiRoot, '.next/node_modules', alias)), await realpath(f.mirror(f.sharp)))
        // The graph remains usable after the source checkout disappears; no build-machine links.
        await rm(f.repo, { recursive: true, force: true })
        assert.equal(await readFile(join(adjacent, 'lib/libvips-cpp.8.18.3.dylib'), 'utf8'), 'fixture matching native library')
        assert.equal((await readUiSharpManifest(f.uiRoot)).version, '0.35.1')
    } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('rejects an installed native dependency that does not match the UI Sharp version graph', async () => {
    const f = await fixture()
    try {
        await write(join(f.libvips, 'package.json'), JSON.stringify({ name: vips, version: '1.2.4' }))
        await assert.rejects(stageUiSharp(f.options), /mismatched UI Sharp native dependency/)
        assert.equal(existsSync(join(f.uiRoot, UI_SHARP_MANIFEST)), false)
    } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('rejects a trace with only the other Sharp version rather than substituting the engine dependency', async () => {
    const f = await fixture()
    try {
        await write(join(f.mirror(f.sharp), 'package.json'), JSON.stringify({ name: 'sharp', version: '0.34.5' }))
        await assert.rejects(stageUiSharp(f.options), /No traced UI Sharp alias matches installed version 0.35.1/)
    } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('rejects dependency source paths and staged aliases outside their allowed roots', async () => {
    const f = await fixture()
    try {
        const outside = join(f.root, 'outside-helper')
        await write(join(outside, 'package.json'), JSON.stringify({ name: 'runtime-helper', version: '2.1.2' }))
        await link(join(dirname(f.sharp), 'runtime-helper'), outside)
        await assert.rejects(stageUiSharp(f.options), /escapes installed node_modules/)
        assert.equal(existsSync(join(f.uiRoot, UI_SHARP_MANIFEST)), false)
        await link(join(dirname(f.sharp), 'runtime-helper'), f.js)
        await stageUiSharp(f.options)
        await link(join(f.uiRoot, '.next/node_modules', alias), f.sharp)
        await assert.rejects(readUiSharpManifest(f.uiRoot), /escapes staging/)
    } finally { await rm(f.root, { recursive: true, force: true }) }
})
