import assert from 'node:assert/strict'
import { mkdir, mkdtemp, lstat, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, test } from 'node:test'
import { assertDesktopValidationIsolation, createDesktopValidationIsolation, readDesktopValidationManifest, withDesktopValidationIsolation } from './isolation.mjs'

const parents = new Set()
afterEach(async () => { for (const parent of parents) await rm(parent, { recursive: true, force: true }); parents.clear() })
async function parent() {
    const value = await realpath(await mkdtemp(join(tmpdir(), 'rerun-validation-contract-')))
    parents.add(value)
    return value
}

test('creates a fresh verified temp profile with no production data or provider credentials', async () => {
    const root = join(await parent(), 'profile')
    const created = await createDesktopValidationIsolation({ root })
    assert.notEqual(created.profile.profileRoot, join(process.env.HOME ?? '/Users/test', '.rerun'))
    assert.equal(created.profile.profileRoot.includes('Rerun Desktop Preview'), false)
    assert.equal(created.profile.dataRoot, join(created.profile.profileRoot, 'data'))
    assert.equal(created.profile.engineRoot, join(created.profile.profileRoot, 'data', 'workspaces', '1', 'engine'))
    assert.equal(created.profile.partition.includes('persist:'), false)
    assert.equal(created.environment.HOME, created.profile.homeRoot)
    assert.equal(created.environment.RERUN_DATA_DIR, created.profile.engineRoot)
    assert.equal(created.environment.RERUN_DESKTOP, 'off')
    assert.equal(created.environment.RERUN_DESKTOP_VALIDATION, '1')
    assert.equal(created.environment.OPENAI_API_KEY, undefined)
    assert.equal(created.environment.ANTHROPIC_API_KEY, undefined)
    assert.equal(created.environment.OPENROUTER_API_KEY, undefined)
    await assertDesktopValidationIsolation(created)
    assert.equal((await lstat(created.manifestPath)).isFile(), true)
    const manifest = JSON.parse(await readFile(created.manifestPath, 'utf8'))
    assert.equal(manifest.profile.externalNetwork, 'waiting-for-launch-enforcement')
    assert.equal((await readDesktopValidationManifest(created.manifestPath)).profile.validationId, created.profile.validationId)
})

test('an existing nonempty profile is never reused as fresh validation state', async () => {
    const root = join(await parent(), 'profile')
    await createDesktopValidationIsolation({ root })
    await assert.rejects(() => createDesktopValidationIsolation({ root }), /not empty/)
})

test('cleanup removes only the verified temporary validation profile', async () => {
    const root = join(await parent(), 'profile')
    const result = await withDesktopValidationIsolation({ root }, async created => {
        assert.equal(created.profile.externalNetwork, 'waiting-for-launch-enforcement')
        return 'done'
    })
    assert.equal(result, 'done')
    await assert.rejects(() => lstat(root), error => error && error.code === 'ENOENT')
})

test('a linked parent is refused before creating a directory at its target', async () => {
    const dir = await parent()
    const outside = await parent()
    const link = join(dir, 'linked')
    await symlink(outside, link, 'dir')
    await assert.rejects(() => createDesktopValidationIsolation({ root: join(link, 'nested', 'profile') }), /linked path/)
    await assert.rejects(() => lstat(join(outside, 'nested')), { code: 'ENOENT' })
})

test('cleanup cannot be redirected by changing the callback profile', async () => {
    const dir = await parent()
    const root = join(dir, 'profile')
    const sibling = join(dir, 'sibling')
    await mkdir(sibling)
    await writeFile(join(sibling, 'keep'), 'keep')
    await withDesktopValidationIsolation({ root }, async ({ profile }) => {
        profile.profileRoot = sibling
        profile.dataRoot = join(sibling, 'data')
        profile.engineRoot = join(profile.dataRoot, 'workspaces', '1', 'engine')
        profile.homeRoot = join(sibling, 'home')
    })
    assert.equal(await readFile(join(sibling, 'keep'), 'utf8'), 'keep')
    await assert.rejects(() => lstat(root), { code: 'ENOENT' })
})

test('cleanup refuses to remove a replacement at the original profile path', async () => {
    const dir = await parent()
    const root = join(dir, 'profile')
    await assert.rejects(() => withDesktopValidationIsolation({ root }, async () => {
        await rename(root, join(dir, 'original'))
        await mkdir(root)
        await writeFile(join(root, 'keep'), 'keep')
    }), /profile changed before cleanup/)
    assert.equal(await readFile(join(root, 'keep'), 'utf8'), 'keep')
})
