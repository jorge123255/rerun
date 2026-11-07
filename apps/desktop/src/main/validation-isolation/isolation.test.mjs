import { mkdtemp, lstat, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { assertDesktopValidationIsolation, createDesktopValidationIsolation, readDesktopValidationManifest, withDesktopValidationIsolation } from './isolation'

const parents = new Set()
afterEach(async () => { for (const parent of parents) await rm(parent, { recursive: true, force: true }); parents.clear() })
async function parent() { const value = await mkdtemp(join(tmpdir(), 'rerun-validation-contract-')); parents.add(value); return value }

test('creates a fresh verified temp profile with no production data or provider credentials', async () => {
    const root = join(await parent(), 'profile')
    const created = await createDesktopValidationIsolation({ root })
    expect(created.profile.profileRoot).not.toBe(join(process.env.HOME ?? '/Users/test', '.rerun'))
    expect(created.profile.profileRoot).not.toContain('Rerun Desktop Preview')
    expect(created.profile.dataRoot).toBe(join(created.profile.profileRoot, 'data'))
    expect(created.profile.engineRoot).toBe(join(created.profile.profileRoot, 'data', 'workspaces', '1', 'engine'))
    expect(created.profile.partition).not.toContain('persist:')
    expect(created.environment.HOME).toBe(created.profile.homeRoot)
    expect(created.environment.RERUN_DATA_DIR).toBe(created.profile.engineRoot)
    expect(created.environment.RERUN_DESKTOP).toBe('off')
    expect(created.environment.RERUN_DESKTOP_VALIDATION).toBe('1')
    expect(created.environment.OPENAI_API_KEY).toBeUndefined()
    expect(created.environment.ANTHROPIC_API_KEY).toBeUndefined()
    expect(created.environment.OPENROUTER_API_KEY).toBeUndefined()
    await assertDesktopValidationIsolation(created)
    expect((await lstat(created.manifestPath)).isFile()).toBe(true)
    const manifest = JSON.parse(await readFile(created.manifestPath, 'utf8'))
    expect(manifest.profile.externalNetwork).toBe('waiting-for-launch-enforcement')
    expect((await readDesktopValidationManifest(created.manifestPath)).profile.validationId).toBe(created.profile.validationId)
})

test('an existing nonempty profile is never reused as fresh validation state', async () => {
    const root = join(await parent(), 'profile')
    await createDesktopValidationIsolation({ root })
    await expect(createDesktopValidationIsolation({ root })).rejects.toThrow('not empty')
})

test('cleanup removes only the verified temporary validation profile', async () => {
    const root = join(await parent(), 'profile')
    const result = await withDesktopValidationIsolation({ root }, async created => {
        expect(created.profile.externalNetwork).toBe('waiting-for-launch-enforcement')
        return 'done'
    })
    expect(result).toBe('done')
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
})
