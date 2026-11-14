// Builds the Mac release: Developer ID signature, hardened runtime, Apple notarization, a stapled
// app in a zip (what the in-app updater installs) and in a disk image (what people download), and
// the update feed that names the zip.
//
// Nothing here uploads anything. The files land in --output-dir; putting them where the feed URL
// points is a separate, deliberate step.
//
//   pnpm desktop:release --output-dir /absolute/dir
//   pnpm desktop:release --output-dir /absolute/dir --local-check
//
// --local-check builds the same hardened bundle, zip and disk image with the local preview
// certificate and skips Apple. It exists to try the release shape on a Mac that has no Developer ID.
// Its bundle carries no update feed and must not be given to anyone.
//
// The staple and validate retry follows CopilotKit/OpenBot's desktop/scripts/staple-with-retry.sh
// (MIT): stapler exits 68 when its connection to Apple drops, and only that is tried again.
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TEAM_ID = /^[A-Z0-9]{10}$/
const BUNDLE_ID = /^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)+$/
const VERSION = /^\d+\.\d+\.\d+$/
const PRODUCT = /^[A-Za-z0-9][A-Za-z0-9 ]{0,38}[A-Za-z0-9]$/
const KEY_ID = /^[A-Z0-9]{10}$/
const ISSUER = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export const LOCAL_CHECK_BUNDLE_ID = 'build.rerun.desktop.localcheck'
export const LOCAL_CHECK_PRODUCT = 'Rerun Local Check'

function httpsUrl(value) {
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url : null
    } catch { return null }
}

// Everything a release needs, read once and refused together, before any build starts.
export function releaseSettings(env, packageVersion) {
    const problems = []
    const value = name => typeof env[name] === 'string' ? env[name].trim() : ''
    const bundleId = value('RERUN_RELEASE_BUNDLE_ID')
    const teamId = value('RERUN_RELEASE_TEAM_ID')
    const identity = value('RERUN_RELEASE_IDENTITY')
    const feedUrl = value('RERUN_RELEASE_FEED_URL')
    const downloadUrl = value('RERUN_RELEASE_DOWNLOAD_URL')
    const productName = value('RERUN_RELEASE_PRODUCT_NAME') || 'Rerun'
    const version = value('RERUN_RELEASE_VERSION') || packageVersion

    if (!BUNDLE_ID.test(bundleId) || bundleId.length > 150) problems.push('RERUN_RELEASE_BUNDLE_ID must be a bundle ID such as build.rerun.desktop.')
    else if (/\.(preview|localcheck)$/.test(bundleId)) problems.push('RERUN_RELEASE_BUNDLE_ID must not be the preview or local-check bundle ID.')
    if (!TEAM_ID.test(teamId)) problems.push('RERUN_RELEASE_TEAM_ID must be the ten-character Apple team ID.')
    if (!identity) problems.push('RERUN_RELEASE_IDENTITY must name the Developer ID Application certificate, or give its SHA-1.')
    if (!httpsUrl(feedUrl)) problems.push('RERUN_RELEASE_FEED_URL must be the https address the update feed will be served from.')
    if (!httpsUrl(downloadUrl)) problems.push('RERUN_RELEASE_DOWNLOAD_URL must be the https folder the release zip will be served from.')
    if (!PRODUCT.test(productName) || /preview|local check/i.test(productName)) problems.push('RERUN_RELEASE_PRODUCT_NAME must be a plain app name, and not the preview’s.')
    if (!VERSION.test(version ?? '')) problems.push('The release version must look like 1.2.3 (RERUN_RELEASE_VERSION, or the version in apps/desktop/package.json).')

    const profile = value('RERUN_NOTARY_KEYCHAIN_PROFILE')
    const key = value('RERUN_NOTARY_KEY_PATH'), keyId = value('RERUN_NOTARY_KEY_ID'), issuer = value('RERUN_NOTARY_ISSUER')
    let notary = null
    if (profile && (key || keyId || issuer)) problems.push('Give Apple’s notary either RERUN_NOTARY_KEYCHAIN_PROFILE or the three RERUN_NOTARY_KEY_* values, not both.')
    else if (profile) notary = { profile }
    else if (isAbsolute(key) && KEY_ID.test(keyId) && ISSUER.test(issuer)) notary = { key, keyId, issuer }
    else problems.push('Apple’s notary needs RERUN_NOTARY_KEYCHAIN_PROFILE, or RERUN_NOTARY_KEY_PATH (absolute), RERUN_NOTARY_KEY_ID and RERUN_NOTARY_ISSUER.')

    if (problems.length) throw new Error('The release is not configured:\n- ' + problems.join('\n- '))
    return { bundleId, teamId, identity, feedUrl, downloadUrl: downloadUrl.replace(/\/+$/, ''), productName, version, notary }
}

// The one Developer ID Application certificate asked for, checked against the team.
export function chooseReleaseIdentity(listing, requested, teamId) {
    const identities = [...listing.matchAll(/^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"([^"\r\n]+)"\s*$/gm)]
        .map(([, hash, name]) => ({ hash: hash.toUpperCase(), name }))
        .filter(({ name }) => name.startsWith('Developer ID Application:'))
    const selected = identities.filter(row => row.hash === requested.toUpperCase() || row.name === requested)
    if (selected.length !== 1) throw new Error('The Developer ID Application certificate named by RERUN_RELEASE_IDENTITY is not uniquely available in the Keychain.')
    if (!selected[0].name.endsWith(`(${teamId})`)) throw new Error('The Developer ID Application certificate does not belong to RERUN_RELEASE_TEAM_ID.')
    return selected[0]
}

// What the packaged app reads at launch to decide whether it may check for updates, and where.
// It also names the app's own profile folder, so a release never opens the preview's data.
export function releaseConfigSource(settings) {
    const json = value => JSON.stringify(value ?? '')
    return [
        '// Written by scripts/desktop/release.mjs for this build.',
        `export const PRODUCTION_FEED_URL = ${json(settings.feedUrl)}`,
        `export const PROFILE_NAME = ${json(settings.productName)}`,
        '',
        'export const BUILD_RELEASE = Object.freeze({',
        `    channel: ${json(settings.feedUrl ? 'stable' : 'preview')},`,
        `    feedUrl: ${json(settings.feedUrl)},`,
        "    devFeedUrl: '',",
        `    teamId: ${json(settings.teamId)},`,
        `    bundleId: ${json(settings.feedUrl ? settings.bundleId : '')},`,
        '})',
        '',
    ].join('\n')
}

export function releaseBuilderArguments({ arch, bundleId, productName, version, identity, type, output }) {
    return ['--mac', 'dir', `--${arch}`, '--publish', 'never', '--config', 'electron-builder.yml',
        `-c.appId=${bundleId}`, `-c.productName=${productName}`, `-c.extraMetadata.version=${version}`,
        `-c.mac.identity=${identity}`, `-c.mac.type=${type}`, '-c.forceCodeSigning=true', '-c.mac.notarize=false',
        '-c.mac.hardenedRuntime=true', '-c.mac.entitlements=entitlements/release.plist',
        '-c.mac.entitlementsInherit=entitlements/release.inherit.plist', `-c.directories.output=${output}`]
}

export function notaryArguments(notary) {
    return notary.profile ? ['--keychain-profile', notary.profile] : ['--key', notary.key, '--key-id', notary.keyId, '--issuer', notary.issuer]
}

// The requirement the in-app updater tests its own bundle against before it will touch the feed.
export function releaseRequirement({ bundleId, teamId }) {
    return `anchor apple generic and identifier "${bundleId}" and certificate leaf[subject.OU] = "${teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`
}

// Squirrel.Mac's JSON feed: the current version and, for each listed version, the zip to install.
export function updateFeed({ version, url, notes = '', pubDate, previous }) {
    if (!VERSION.test(version)) throw new Error('The feed version must look like 1.2.3.')
    if (!httpsUrl(url) || !url.endsWith('.zip')) throw new Error('The feed must point at an https .zip.')
    const kept = Array.isArray(previous?.releases)
        ? previous.releases.filter(row => VERSION.test(row?.version ?? '') && row.version !== version && httpsUrl(row?.updateTo?.url))
        : []
    return { currentRelease: version, releases: [...kept, { version, updateTo: { version, name: version, pub_date: pubDate, notes, url } }] }
}

function execute(command, args, options = {}) {
    return new Promise((done, fail) => {
        const capture = options.capture === true
        const child = spawn(command, args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], cwd: options.cwd })
        let stdout = ''
        child.stdout?.on('data', chunk => { stdout += chunk })
        child.once('error', fail)
        child.once('exit', code => done({ code, stdout }))
    })
}

// Staples a notarization ticket, or validates the stapled one, trying again only when stapler
// could not reach Apple (exit 68). Any other code is Apple's answer and fails at once.
export async function stapleWithRetry(file, { action = 'staple', attempts = 5, delay = 15_000, run = execute, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
    if (action !== 'staple' && action !== 'validate') throw new Error('The stapler action must be staple or validate.')
    let wait = delay
    for (let attempt = 1; ; attempt++) {
        const { code } = await run('/usr/bin/xcrun', ['stapler', action, file])
        if (code === 0) return attempt
        if (code !== 68 || attempt >= attempts) throw new Error(`stapler ${action} failed for ${file} with exit code ${code} after ${attempt} attempt${attempt === 1 ? '' : 's'}.`)
        console.log(`stapler could not reach Apple (attempt ${attempt} of ${attempts}); trying again in ${Math.round(wait / 1000)} s.`)
        await sleep(wait)
        wait *= 2
    }
}

export async function notarize(file, notary, run = execute) {
    const credentials = notaryArguments(notary)
    const { code, stdout } = await run('/usr/bin/xcrun', ['notarytool', 'submit', file, '--wait', '--output-format', 'json', ...credentials], { capture: true })
    let answer = {}
    try { answer = JSON.parse(stdout) } catch { /* Apple's text explains itself below. */ }
    if (code === 0 && answer.status === 'Accepted') return answer.id
    if (typeof answer.id === 'string') await run('/usr/bin/xcrun', ['notarytool', 'log', answer.id, ...credentials])
    throw new Error(`Apple did not accept ${file} for notarization${answer.status ? ` (${answer.status})` : ''}.`)
}

async function must(command, args, options) {
    const result = await execute(command, args, options)
    if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.code}`)
    return result.stdout.trim()
}

async function codeHash(app) {
    const child = spawn('/usr/bin/codesign', ['-dv', '--verbose=4', app], { stdio: ['ignore', 'ignore', 'pipe'] })
    let text = ''
    child.stderr.on('data', chunk => { text += chunk })
    await new Promise((done, fail) => { child.once('error', fail); child.once('exit', done) })
    const hash = text.match(/^CDHash=([0-9a-f]+)$/m)?.[1]
    if (!hash) throw new Error(`Could not read the code signature of ${app}.`)
    return { hash, hardened: /flags=.*runtime/.test(text), adhoc: /Signature=adhoc/.test(text) }
}

async function main() {
    const { flag, desktopDir, repoRoot, output, sha256File } = await import('./lib.mjs')
    const { matchesSourceStamp, sourceStamp } = await import('./provenance.mjs')
    const { macTarget } = await import('./mac-target.mjs')
    const { verifyBundle } = await import('./install.mjs')
    const { verifyPackagedElectron } = await import('./verify-electron.mjs')
    const { choosePreviewSigningIdentity } = await import('./signing.mjs')

    const localCheck = flag('--local-check')
    const outputFlag = process.argv.indexOf('--output-dir')
    const out = outputFlag === -1 ? '' : process.argv[outputFlag + 1] ?? ''
    if (!isAbsolute(out)) throw new Error('--output-dir requires an absolute build directory.')
    const packageVersion = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8')).version
    const listing = await output('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])

    let settings, identity
    if (localCheck) {
        identity = choosePreviewSigningIdentity(listing, process.env.RERUN_DESKTOP_SIGN_IDENTITY)
        settings = { bundleId: LOCAL_CHECK_BUNDLE_ID, productName: LOCAL_CHECK_PRODUCT, version: packageVersion }
        console.log('Local check: preview certificate, no notarization, no update feed. Not for distribution.')
    } else {
        settings = releaseSettings(process.env, packageVersion)
        identity = { ...chooseReleaseIdentity(listing, settings.identity, settings.teamId), type: 'distribution' }
        if (!(await lstat(settings.notary.key ?? '/').catch(() => null))) throw new Error('RERUN_NOTARY_KEY_PATH does not exist.')
    }

    const initial = await sourceStamp()
    const untracked = await output('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot })
    if (untracked) throw new Error('A release needs a clean worktree. Move or commit untracked files first.')
    await mkdir(out, { recursive: true })

    console.log('\n--- staging')
    await must(process.execPath, [join(repoRoot, 'scripts', 'desktop', 'package.mjs'), '--stage-only'], { cwd: repoRoot })
    await writeFile(join(desktopDir, 'dist', 'main', 'release-config.mjs'), releaseConfigSource(settings))

    const { arch, appDirectory } = macTarget()
    console.log('\n--- signing with the hardened runtime')
    await must('npx', ['--yes', 'electron-builder@26.18.1', ...releaseBuilderArguments({
        arch, bundleId: settings.bundleId, productName: settings.productName, version: settings.version, identity: identity.hash, type: identity.type, output: out,
    })], { cwd: desktopDir })

    const bundle = `${settings.productName}.app`
    const app = join(out, appDirectory, bundle)
    const verifyApp = async path => {
        await must('/usr/bin/codesign', ['--verify', '--deep', '--strict', path])
        if (!localCheck) await must('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', `=${releaseRequirement(settings)}`, path])
        const signature = await codeHash(path)
        if (!signature.hardened || signature.adhoc) throw new Error(`${path} is not signed with the hardened runtime.`)
        await verifyPackagedElectron(path)
        await verifyBundle(path, initial, settings.bundleId)
        return signature.hash
    }
    const signed = await verifyApp(app)

    if (!localCheck) {
        console.log('\n--- notarizing the app')
        const upload = join(out, 'notarize.zip')
        await must('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, upload])
        await notarize(upload, settings.notary)
        await rm(upload)
        await stapleWithRetry(app)
        await stapleWithRetry(app, { action: 'validate' })
        await must('/usr/sbin/spctl', ['-a', '-t', 'exec', '-vv', app])
    }

    const base = `${settings.productName.replaceAll(' ', '-')}-${settings.version}-mac-${arch}`
    const zip = join(out, `${base}.zip`)
    const image = join(out, `${base}.dmg`)
    console.log('\n--- update zip and disk image')
    await rm(zip, { force: true })
    await must('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
    await must('npx', ['--yes', 'electron-builder@26.18.1', '--prepackaged', app, '--mac', 'dmg', `--${arch}`, '--publish', 'never',
        '--config', 'electron-builder.yml', `-c.appId=${settings.bundleId}`, `-c.productName=${settings.productName}`,
        `-c.extraMetadata.version=${settings.version}`, `-c.directories.output=${out}`, `-c.dmg.artifactName=${base}.dmg`,
        '-c.dmg.writeUpdateInfo=false', '-c.dmg.sign=false', '-c.mac.identity=null'], { cwd: desktopDir })
    await must('/usr/bin/codesign', ['--sign', identity.hash, ...(localCheck ? [] : ['--timestamp']), image])
    if (!localCheck) {
        console.log('\n--- notarizing the disk image')
        await notarize(image, settings.notary)
        await stapleWithRetry(image)
        await stapleWithRetry(image, { action: 'validate' })
        await must('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv', image])
    }

    // The disk image must hold the very bundle that was signed and stapled, not a re-signed copy.
    await must('/usr/bin/hdiutil', ['verify', image])
    const mount = await mkdtemp(join(await realpath(tmpdir()), 'rerun-release-dmg-'))
    let attached = false
    try {
        await must('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, image])
        attached = true
        if (await verifyApp(join(mount, bundle)) !== signed) throw new Error('The disk image holds a different signature than the notarized app.')
    } finally {
        if (attached) await must('/usr/bin/hdiutil', ['detach', mount])
        await rmdir(mount)
    }
    const unpacked = await mkdtemp(join(await realpath(tmpdir()), 'rerun-release-zip-'))
    try {
        await must('/usr/bin/ditto', ['-x', '-k', zip, unpacked])
        if (await verifyApp(join(unpacked, bundle)) !== signed) throw new Error('The update zip holds a different signature than the notarized app.')
        if (!localCheck) await stapleWithRetry(join(unpacked, bundle), { action: 'validate' })
    } finally { await rm(unpacked, { recursive: true, force: true }) }

    const sums = [`${await sha256File(zip)}  ${base}.zip`, `${await sha256File(image)}  ${base}.dmg`]
    if (!localCheck) {
        const feedName = new URL(settings.feedUrl).pathname.split('/').pop() || 'releases.json'
        const previousFile = process.env.RERUN_RELEASE_PREVIOUS_FEED
        const previous = previousFile ? JSON.parse(await readFile(previousFile, 'utf8')) : undefined
        const notesFile = process.env.RERUN_RELEASE_NOTES_FILE
        const feed = updateFeed({
            version: settings.version, url: `${settings.downloadUrl}/${encodeURIComponent(`${base}.zip`)}`,
            notes: notesFile ? (await readFile(notesFile, 'utf8')).trim() : '', pubDate: new Date().toISOString(), previous,
        })
        await writeFile(join(out, feedName), JSON.stringify(feed, null, 2) + '\n')
        sums.push(`${await sha256File(join(out, feedName))}  ${feedName}`)
    }
    await writeFile(join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
    if (!matchesSourceStamp(await sourceStamp(), initial)) throw new Error('The source changed during the release build.')
    console.log(`\n${localCheck ? 'local check' : 'release'} complete for ${initial.sourceCommit}: ${out}`)
    console.log(sums.join('\n'))
    if (!localCheck) console.log('Nothing was uploaded. Publish the zip, the disk image and the feed together.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
