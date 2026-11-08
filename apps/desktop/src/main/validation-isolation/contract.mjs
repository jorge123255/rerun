import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const DESKTOP_VALIDATION_FLAG = '--rerun-validation-profile'
export const DESKTOP_VALIDATION_CONTRACT_VERSION = 1

/**
 * @typedef {object} DesktopValidationProfile
 * @property {1} version
 * @property {string} validationId
 * @property {string} profileRoot
 * @property {string} dataRoot
 * @property {string} engineRoot
 * @property {string} homeRoot
 * @property {string} partition
 * @property {'empty-by-fresh-profile'} providers
 * @property {'waiting-for-launch-enforcement'} externalNetwork
 * @property {'ephemeral-only'} loopback
 */

/**
 * @typedef {object} DesktopValidationIsolation
 * @property {DesktopValidationProfile} profile
 * @property {Record<string,string>} environment
 * @property {string} manifestPath
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function desktopValidationProfileError(message, code = 'invalid_validation_profile') {
    return Object.assign(new Error(message), { code })
}

export function desktopValidationFlagValue(argv) {
    const matches = argv.filter(value => value.startsWith(`${DESKTOP_VALIDATION_FLAG}=`) || value === DESKTOP_VALIDATION_FLAG)
    if (!matches.length) return null
    if (matches.length > 1) throw desktopValidationProfileError(`${DESKTOP_VALIDATION_FLAG} may be supplied only once.`, 'validation_flag_repeated')
    const value = matches[0].slice(`${DESKTOP_VALIDATION_FLAG}=`.length)
    if (!value || !isAbsolute(value)) throw desktopValidationProfileError(`${DESKTOP_VALIDATION_FLAG} requires an absolute path.`, 'validation_flag_invalid')
    return value
}

function assertTemporaryRoot(profileRoot) {
    if (typeof profileRoot !== 'string' || !isAbsolute(profileRoot)) throw desktopValidationProfileError('A validation profile needs an absolute temporary path.')
    const resolved = resolve(profileRoot)
    if (resolved === sep) throw desktopValidationProfileError('A validation profile cannot be the filesystem root.')
    const tempRoots = new Set([resolve(tmpdir()), realpathSync(tmpdir())])
    for (const root of tempRoots) {
        const rel = relative(root, resolved)
        if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return resolved
    }
    throw desktopValidationProfileError('A validation profile must be inside the system temporary directory.')
}

export function validateDesktopValidationProfile(input) {
    const profileRoot = assertTemporaryRoot(input.profileRoot)
    if (input.version === undefined) return profileRoot
    if (input.version !== DESKTOP_VALIDATION_CONTRACT_VERSION || !UUID.test(input.validationId)) throw desktopValidationProfileError('Unsupported validation profile identity.')
    const dataRoot = resolve(profileRoot, 'data')
    const engineRoot = resolve(dataRoot, 'workspaces', '1', 'engine')
    const homeRoot = resolve(profileRoot, 'home')
    if (input.dataRoot !== dataRoot || input.engineRoot !== engineRoot || input.homeRoot !== homeRoot) throw desktopValidationProfileError('Validation profile paths do not form an isolated data directory.')
    if (input.partition !== `validation-${input.validationId}` || input.partition.startsWith('persist:')) throw desktopValidationProfileError('Validation must use a nonpersistent Electron partition.')
    if (input.providers !== 'empty-by-fresh-profile') throw desktopValidationProfileError('Validation providers must start empty.')
    if (input.externalNetwork !== 'waiting-for-launch-enforcement') throw desktopValidationProfileError('External network isolation is not proven by this package.')
    if (input.loopback !== 'ephemeral-only') throw desktopValidationProfileError('Validation loopback must be ephemeral.')
    return { ...input, profileRoot }
}

export const DESKTOP_VALIDATION_PROVIDER_ENV_KEYS = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'BRAVE_API_KEY',
    'CODEX_API_KEY',
    'CLAUDE_API_KEY',
]
