import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
    chooseReleaseIdentity, notarize, notaryArguments, releaseBuilderArguments, releaseConfigSource, releaseRequirement,
    releaseSettings, releaseStartupPage, stapleWithRetry, updateFeed, LOCAL_CHECK_PRODUCT,
} from './release.mjs'

const TEAM = 'ABCDE12345'
const env = (overrides = {}) => ({
    RERUN_RELEASE_BUNDLE_ID: 'build.rerun.desktop', RERUN_RELEASE_TEAM_ID: TEAM,
    RERUN_RELEASE_IDENTITY: `Developer ID Application: Example (${TEAM})`,
    RERUN_RELEASE_FEED_URL: 'https://updates.example.test/mac/releases.json',
    RERUN_RELEASE_DOWNLOAD_URL: 'https://updates.example.test/mac/',
    RERUN_NOTARY_KEYCHAIN_PROFILE: 'rerun-notary', ...overrides,
})

test('a complete configuration is read once, with the package version and the default name', () => {
    assert.deepEqual(releaseSettings(env(), '0.1.0'), {
        bundleId: 'build.rerun.desktop', teamId: TEAM, identity: `Developer ID Application: Example (${TEAM})`,
        feedUrl: 'https://updates.example.test/mac/releases.json', downloadUrl: 'https://updates.example.test/mac',
        productName: 'Rerun', version: '0.1.0', notary: { profile: 'rerun-notary' },
    })
    const keyed = releaseSettings(env({
        RERUN_NOTARY_KEYCHAIN_PROFILE: '', RERUN_NOTARY_KEY_PATH: '/keys/AuthKey.p8', RERUN_NOTARY_KEY_ID: 'KEY1234567',
        RERUN_NOTARY_ISSUER: '12345678-1234-1234-1234-123456789abc', RERUN_RELEASE_VERSION: '1.2.3',
    }), '0.1.0')
    assert.equal(keyed.version, '1.2.3')
    assert.deepEqual(notaryArguments(keyed.notary), ['--key', '/keys/AuthKey.p8', '--key-id', 'KEY1234567', '--issuer', '12345678-1234-1234-1234-123456789abc'])
    assert.deepEqual(notaryArguments({ profile: 'rerun-notary' }), ['--keychain-profile', 'rerun-notary'])
})

test('every missing or unsafe value is named before anything is built', () => {
    assert.throws(() => releaseSettings({}, '0.1.0'), error => {
        for (const name of ['RERUN_RELEASE_BUNDLE_ID', 'RERUN_RELEASE_TEAM_ID', 'RERUN_RELEASE_IDENTITY', 'RERUN_RELEASE_FEED_URL', 'RERUN_RELEASE_DOWNLOAD_URL', 'RERUN_NOTARY_KEYCHAIN_PROFILE']) {
            assert.match(error.message, new RegExp(name))
        }
        return true
    })
    const refused = [
        [{ RERUN_RELEASE_BUNDLE_ID: 'build.rerun.desktop.preview' }, /preview or local-check/],
        [{ RERUN_RELEASE_TEAM_ID: 'development' }, /TEAM_ID/],
        [{ RERUN_RELEASE_FEED_URL: 'http://updates.example.test/releases.json' }, /FEED_URL/],
        [{ RERUN_RELEASE_FEED_URL: 'https://user:secret@updates.example.test/releases.json' }, /FEED_URL/],
        [{ RERUN_RELEASE_DOWNLOAD_URL: 'https://updates.example.test/mac?token=1' }, /DOWNLOAD_URL/],
        [{ RERUN_RELEASE_PRODUCT_NAME: 'Rerun Desktop Preview' }, /PRODUCT_NAME/],
        [{ RERUN_RELEASE_PRODUCT_NAME: LOCAL_CHECK_PRODUCT }, /PRODUCT_NAME/],
        [{ RERUN_RELEASE_PRODUCT_NAME: '../Rerun' }, /PRODUCT_NAME/],
        [{ RERUN_RELEASE_VERSION: '1.2' }, /1\.2\.3/],
        [{ RERUN_NOTARY_KEY_PATH: '/keys/AuthKey.p8' }, /not both/],
        [{ RERUN_NOTARY_KEYCHAIN_PROFILE: '', RERUN_NOTARY_KEY_PATH: 'AuthKey.p8', RERUN_NOTARY_KEY_ID: 'KEY1234567', RERUN_NOTARY_ISSUER: '12345678-1234-1234-1234-123456789abc' }, /notary needs/],
    ]
    for (const [overrides, message] of refused) assert.throws(() => releaseSettings(env(overrides), '0.1.0'), message)
})

test('only the named Developer ID Application certificate of the team signs a release', () => {
    const row = (hash, name) => `  1) ${hash} "${name}"\n`
    const id = 'A'.repeat(40)
    const listing = row(id, `Developer ID Application: Example (${TEAM})`) + row('B'.repeat(40), 'Apple Development: Example (ZZZZZ99999)')
        + row('C'.repeat(40), `Developer ID Installer: Example (${TEAM})`)
    assert.equal(chooseReleaseIdentity(listing, `Developer ID Application: Example (${TEAM})`, TEAM).hash, id)
    assert.equal(chooseReleaseIdentity(listing, id.toLowerCase(), TEAM).hash, id)
    assert.throws(() => chooseReleaseIdentity(listing, 'B'.repeat(40), TEAM), /not uniquely available/)
    assert.throws(() => chooseReleaseIdentity(listing, 'C'.repeat(40), TEAM), /not uniquely available/)
    assert.throws(() => chooseReleaseIdentity(listing, id, 'OTHER12345'), /does not belong/)
})

test('the release config turns the updater on for exactly this feed, team and bundle', async () => {
    const settings = releaseSettings(env(), '0.1.0')
    const source = releaseConfigSource(settings)
    const module = await import('data:text/javascript,' + encodeURIComponent(source))
    assert.equal(module.PRODUCTION_FEED_URL, settings.feedUrl)
    assert.equal(module.PROFILE_NAME, 'Rerun')
    assert.deepEqual({ ...module.BUILD_RELEASE }, { channel: 'stable', feedUrl: settings.feedUrl, devFeedUrl: '', teamId: TEAM, bundleId: 'build.rerun.desktop' })
    const { resolveMacUpdateFeed } = await import('../../apps/desktop/src/main/mac-updates.mjs')
    assert.deepEqual(resolveMacUpdateFeed({ ...module.BUILD_RELEASE, packaged: true }, module.PRODUCTION_FEED_URL),
        { enabled: true, feedUrl: settings.feedUrl, production: true, reason: 'production' })

    // A local check has its own profile folder and no feed, team or bundle to update against.
    const local = await import('data:text/javascript,' + encodeURIComponent(releaseConfigSource({ productName: LOCAL_CHECK_PRODUCT })))
    assert.equal(local.PROFILE_NAME, LOCAL_CHECK_PRODUCT)
    assert.deepEqual({ ...local.BUILD_RELEASE }, { channel: 'preview', feedUrl: '', devFeedUrl: '', teamId: '', bundleId: '' })
    assert.equal(resolveMacUpdateFeed({ ...local.BUILD_RELEASE, packaged: true }, local.PRODUCTION_FEED_URL).enabled, false)
})

test('the builder signs with the hardened runtime and never notarizes or publishes by itself', () => {
    const args = releaseBuilderArguments({ arch: 'arm64', bundleId: 'build.rerun.desktop', productName: 'Rerun', version: '1.2.3', identity: 'A'.repeat(40), type: 'distribution', output: '/out' })
    for (const expected of ['-c.mac.hardenedRuntime=true', '-c.mac.notarize=false', '-c.forceCodeSigning=true', '-c.appId=build.rerun.desktop',
        '-c.mac.entitlements=entitlements/release.plist', '-c.mac.entitlementsInherit=entitlements/release.inherit.plist', '-c.directories.output=/out']) {
        assert.ok(args.includes(expected), expected)
    }
    assert.deepEqual(args.slice(0, 5), ['--mac', 'dir', '--arm64', '--publish', 'never'])
    assert.match(releaseRequirement({ bundleId: 'build.rerun.desktop', teamId: TEAM }), /identifier "build\.rerun\.desktop" and certificate leaf\[subject\.OU\] = "ABCDE12345" and certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists$/)
})

test('stapler is tried again only when it could not reach Apple', async () => {
    const waits = []
    const stapler = codes => { const calls = []; return { calls, run: async (command, args) => { calls.push([command, ...args]); return { code: codes.shift(), stdout: '' } } } }
    const sleep = async ms => { waits.push(ms) }

    const dropped = stapler([68, 68, 0])
    assert.equal(await stapleWithRetry('/out/Rerun.app', { run: dropped.run, sleep, delay: 10 }), 3)
    assert.deepEqual(waits.splice(0), [10, 20])
    assert.deepEqual(dropped.calls[0], ['/usr/bin/xcrun', 'stapler', 'staple', '/out/Rerun.app'])

    const noTicket = stapler([65])
    await assert.rejects(stapleWithRetry('/out/Rerun.dmg', { action: 'validate', run: noTicket.run, sleep }), /exit code 65 after 1 attempt\./)
    assert.deepEqual(noTicket.calls, [['/usr/bin/xcrun', 'stapler', 'validate', '/out/Rerun.dmg']])
    assert.deepEqual(waits, [])

    const never = stapler([68, 68, 68])
    await assert.rejects(stapleWithRetry('/out/Rerun.app', { attempts: 3, run: never.run, sleep, delay: 1 }), /exit code 68 after 3 attempts\./)
    assert.equal(never.calls.length, 3)
    await assert.rejects(stapleWithRetry('/out/Rerun.app', { action: 'remove' }), /staple or validate/)
})

test('only an Accepted answer from Apple counts, and a refusal prints Apple’s log', async () => {
    const calls = []
    const answer = (code, body) => async (command, args) => { calls.push(args.slice(0, 3)); return { code, stdout: JSON.stringify(body) } }
    assert.equal(await notarize('/out/a.zip', { profile: 'p' }, answer(0, { id: 'abc', status: 'Accepted' })), 'abc')
    assert.deepEqual(calls.splice(0), [['notarytool', 'submit', '/out/a.zip']])
    await assert.rejects(notarize('/out/a.zip', { profile: 'p' }, answer(0, { id: 'abc', status: 'Invalid' })), /did not accept .* \(Invalid\)/)
    assert.deepEqual(calls.splice(0), [['notarytool', 'submit', '/out/a.zip'], ['notarytool', 'log', 'abc']])
    await assert.rejects(notarize('/out/a.zip', { profile: 'p' }, async () => ({ code: 1, stdout: 'no network' })), /did not accept/)
})

test('the feed names the new zip, keeps earlier versions and drops anything that is not a release', () => {
    const first = updateFeed({ version: '1.0.0', url: 'https://updates.example.test/mac/Rerun-1.0.0-mac-arm64.zip', pubDate: '2026-11-14T00:00:00.000Z' })
    assert.deepEqual(first, { currentRelease: '1.0.0', releases: [{ version: '1.0.0', updateTo: {
        version: '1.0.0', name: '1.0.0', pub_date: '2026-11-14T00:00:00.000Z', notes: '', url: 'https://updates.example.test/mac/Rerun-1.0.0-mac-arm64.zip' } }] })
    const previous = { ...first, releases: [...first.releases, { version: 'nope' }, { version: '0.9.0', updateTo: { url: 'http://insecure.example.test/a.zip' } }] }
    const second = updateFeed({ version: '1.1.0', url: 'https://updates.example.test/mac/Rerun-1.1.0-mac-arm64.zip', notes: 'Faster.', pubDate: '2026-11-15T00:00:00.000Z', previous })
    assert.equal(second.currentRelease, '1.1.0')
    assert.deepEqual(second.releases.map(row => row.version), ['1.0.0', '1.1.0'])
    assert.deepEqual(updateFeed({ ...second.releases[1].updateTo, pubDate: 'x', previous: second }).releases.map(row => row.version), ['1.0.0', '1.1.0'])
    assert.throws(() => updateFeed({ version: '1.1.0', url: 'http://updates.example.test/a.zip', pubDate: 'x' }), /https \.zip/)
    assert.throws(() => updateFeed({ version: '1.1.0', url: 'https://updates.example.test/a.dmg', pubDate: 'x' }), /https \.zip/)
    assert.throws(() => updateFeed({ version: 'latest', url: 'https://updates.example.test/a.zip', pubDate: 'x' }), /1\.2\.3/)
})

test('the startup page is renamed for the release, and only while it still has its one title', async () => {
    const { readFile } = await import('node:fs/promises')
    const html = await readFile(new URL('../../apps/desktop/src/main/startup.html', import.meta.url), 'utf8')
    const renamed = releaseStartupPage(html, 'Rerun')
    assert.ok(renamed.includes('<title>Rerun</title>'))
    assert.equal(renamed.includes('Preview</title>'), false)
    assert.throws(() => releaseStartupPage(renamed, 'Rerun'), /no longer has the one title/)
})
