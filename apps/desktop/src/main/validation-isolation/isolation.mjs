import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DESKTOP_VALIDATION_CONTRACT_VERSION, DESKTOP_VALIDATION_PROVIDER_ENV_KEYS, desktopValidationProfileError, validateDesktopValidationProfile } from './contract.mjs'

function environmentFor(profile) {
    return {
        HOME: profile.homeRoot,
        RERUN_DATA_DIR: profile.engineRoot,
        RERUN_DESKTOP: 'off',
        RERUN_DESKTOP_VALIDATION: '1',
        RERUN_DESKTOP_VALIDATION_ID: profile.validationId,
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_ENV: 'production',
    }
}

async function statIfPresent(path) {
    try { return await lstat(path) }
    catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
    }
}

async function assertCanonicalAncestor(path) {
    const stat = await statIfPresent(path)
    if (!stat) return assertCanonicalAncestor(dirname(path))
    if (!stat.isDirectory() || await realpath(path) !== path) {
        throw desktopValidationProfileError('Validation profile must not use a linked path.')
    }
}

export async function assertDesktopValidationIsolation(created) {
    const profile = validateDesktopValidationProfile(created.profile)
    for (const path of [profile.profileRoot, profile.dataRoot, profile.engineRoot, profile.homeRoot]) {
        const stat = await lstat(path)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw desktopValidationProfileError('Validation paths must be regular private directories.')
    }
    for (const key of DESKTOP_VALIDATION_PROVIDER_ENV_KEYS) {
        if (created.environment[key] !== undefined) throw desktopValidationProfileError('Validation cannot inherit provider credentials.')
    }
    if (created.environment.HOME !== profile.homeRoot || created.environment.RERUN_DATA_DIR !== profile.engineRoot
        || created.environment.RERUN_DESKTOP !== 'off' || created.environment.RERUN_DESKTOP_VALIDATION !== '1'
        || created.environment.RERUN_DESKTOP_VALIDATION_ID !== profile.validationId) {
        throw desktopValidationProfileError('Validation environment does not match its isolated profile.')
    }
    return true
}

export async function createDesktopValidationIsolation({ root, validationId = randomUUID() }) {
    const profileRoot = validateDesktopValidationProfile({ profileRoot: root })
    await assertCanonicalAncestor(profileRoot)
    await mkdir(profileRoot, { recursive: true, mode: 0o700 })
    const actualRoot = await realpath(profileRoot)
    if (actualRoot !== profileRoot) throw desktopValidationProfileError('Validation profile must not use a linked path.')
    if ((await readdir(actualRoot)).length) throw desktopValidationProfileError('Validation profile is not empty; choose a fresh temporary directory.', 'validation_profile_not_empty')
    const dataRoot = resolve(actualRoot, 'data')
    const engineRoot = resolve(dataRoot, 'workspaces', '1', 'engine')
    const homeRoot = resolve(actualRoot, 'home')
    for (const path of [dataRoot, engineRoot, homeRoot]) await mkdir(path, { recursive: true, mode: 0o700 })
    const profile = validateDesktopValidationProfile({
        version: DESKTOP_VALIDATION_CONTRACT_VERSION,
        validationId,
        profileRoot: actualRoot,
        dataRoot,
        engineRoot,
        homeRoot,
        partition: `validation-${validationId}`,
        providers: 'empty-by-fresh-profile',
        externalNetwork: 'waiting-for-launch-enforcement',
        loopback: 'ephemeral-only',
    })
    const created = { profile, environment: environmentFor(profile), manifestPath: resolve(actualRoot, 'validation-isolation.json') }
    await writeFile(created.manifestPath, `${JSON.stringify({ version: DESKTOP_VALIDATION_CONTRACT_VERSION, profile }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await assertDesktopValidationIsolation(created)
    return created
}

export async function readDesktopValidationManifest(path) {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65_536) throw desktopValidationProfileError('Validation manifest is not a regular private file.')
    const manifest = JSON.parse(await readFile(path, 'utf8'))
    if (manifest.version !== DESKTOP_VALIDATION_CONTRACT_VERSION) throw desktopValidationProfileError('Unsupported validation manifest.')
    return { ...manifest, profile: validateDesktopValidationProfile(manifest.profile) }
}

export async function withDesktopValidationIsolation({ root }, work) {
    const created = await createDesktopValidationIsolation({ root })
    const { profileRoot } = created.profile
    const original = await lstat(profileRoot)
    try { return await work(created) }
    finally {
        const current = await statIfPresent(profileRoot)
        if (current) {
            if (!current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino || await realpath(profileRoot) !== profileRoot) {
                throw desktopValidationProfileError('Validation profile changed before cleanup.')
            }
            await rm(profileRoot, { recursive: true, force: true })
        }
    }
}
