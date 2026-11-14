import { spawnSync } from 'node:child_process'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

const TEAM_ID = /^[A-Z0-9]{10}$/
const BUNDLE_ID = /^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+$/

export function verifyMacUpdateSignature(app, { teamId, bundleId, production }, run = spawnSync) {
    if (!TEAM_ID.test(teamId ?? '') || !BUNDLE_ID.test(bundleId ?? '') || bundleId.length > 150) return false
    try {
        const exe = app.getPath('exe')
        const macOS = dirname(exe)
        const contents = dirname(macOS)
        const bundle = resolve(contents, '..')
        if (!isAbsolute(exe) || basename(macOS) !== 'MacOS' || basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return false
        let requirement = `anchor apple generic and identifier "${bundleId}" and certificate leaf[subject.OU] = "${teamId}"`
        if (production) requirement += ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
        return run('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', `=${requirement}`, bundle],
            { timeout: 15000, stdio: 'ignore' }).status === 0
    } catch { return false }
}
