import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { loadBundle } from '../../apps/desktop/src/main/runtime.mjs'
import { desktopDir, output } from './lib.mjs'
import { choosePreviewSigningIdentity } from './signing.mjs'

const bundleId = 'build.rerun.desktop.preview'
const sandbox = 'com.apple.security.app-sandbox'
const inherit = 'com.apple.security.inherit'

function readPlist(xml) {
    const desktop = createRequire(join(desktopDir, 'package.json'))
    const builder = createRequire(desktop.resolve('electron-builder/package.json'))
    const packager = createRequire(builder.resolve('app-builder-lib/package.json'))
    const signer = createRequire(packager.resolve('@electron/osx-sign'))
    return signer('plist').parse(xml)
}

export function selectMasDevelopmentIdentity(profile, listing, requested, now = Date.now()) {
    const entitlements = profile?.Entitlements
    const team = entitlements?.['com.apple.developer.team-identifier']
    const appIdentifier = entitlements?.['com.apple.application-identifier']
    if (!Array.isArray(profile?.Platform) || !profile.Platform.some(value => value === 'OSX' || value === 'macOS')
        || !/^[A-Z0-9]{10}$/.test(team ?? '') || appIdentifier !== `${team}.${bundleId}`
        || !Array.isArray(profile.ProvisionedDevices) || !profile.ProvisionedDevices.length || profile.ProvisionsAllDevices
        || !(profile.ExpirationDate instanceof Date && profile.ExpirationDate.getTime() > now)) {
        throw new Error(`Use an unexpired Mac development provisioning profile for ${bundleId} with registered test Macs.`)
    }
    const certificates = Array.isArray(profile.DeveloperCertificates) ? profile.DeveloperCertificates : []
    const fingerprints = new Set(certificates
        .filter(Buffer.isBuffer)
        .map(bytes => createHash('sha1').update(bytes).digest('hex').toUpperCase()))
    const eligible = listing.split('\n').filter(line => {
        const match = /^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"(?:Apple Development|Mac Developer):/.exec(line)
        return match && fingerprints.has(match[1].toUpperCase())
    }).join('\n')
    if (!eligible) throw new Error('No available Apple Development signing identity matches the Mac provisioning profile.')
    return { identity: choosePreviewSigningIdentity(eligible, requested).hash, appIdentifier }
}

export async function prepareMasDevelopment(env = process.env) {
    const requestedProfile = env.RERUN_MAS_DEV_PROFILE
    if (!isAbsolute(requestedProfile ?? '')) {
        throw new Error('Set RERUN_MAS_DEV_PROFILE to the absolute path of a Mac development .provisionprofile.')
    }
    const profilePath = await realpath(requestedProfile)
    const profile = readPlist(await output('/usr/bin/security', ['cms', '-D', '-i', profilePath]))
    const listing = await output('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
    const { identity, appIdentifier } = selectMasDevelopmentIdentity(profile, listing, env.RERUN_DESKTOP_SIGN_IDENTITY)
    return { profilePath, appIdentifier, signingArgs: [
        `-c.masDev.identity=${identity}`, `-c.masDev.provisioningProfile=${profilePath}`, '-c.forceCodeSigning=true',
    ] }
}

export async function verifyMasDevelopment(app, signing) {
    const contents = join(app, 'Contents')
    const parent = readPlist(await output('/usr/bin/codesign', ['-d', '--entitlements', ':-', app]))
    if (parent[sandbox] !== true || parent[inherit]
        || parent['com.apple.application-identifier'] !== signing.appIdentifier
        || parent['com.apple.security.network.client'] !== true || parent['com.apple.security.network.server'] !== true) {
        throw new Error('The Mac App Store development app is missing its expected signed sandbox entitlements.')
    }
    if (!(await readFile(join(contents, 'embedded.provisionprofile'))).equals(await readFile(signing.profilePath))) {
        throw new Error('The development app does not contain the selected provisioning profile.')
    }
    const bundle = await loadBundle(join(contents, 'Resources'))
    for (const file of [
        bundle.nodePath, bundle.renameHelperPath, bundle.pdfHelperPath, bundle.pdfTextHelperPath,
        join(dirname(bundle.codexPath), 'codex'), join(dirname(bundle.codexPath), 'codex-code-mode-host'), bundle.claudePath,
    ]) {
        const child = readPlist(await output('/usr/bin/codesign', ['-d', '--entitlements', ':-', file]))
        if (child[sandbox] !== true || child[inherit] !== true) throw new Error(`Missing sandbox inheritance for ${file}`)
    }
}
