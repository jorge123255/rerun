import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { choosePreviewSigningIdentity } from './signing.mjs'
import { selectMasDevelopmentIdentity } from './mas-development.mjs'

const dev = 'A'.repeat(40), dist = 'B'.repeat(40)
const row = (hash, name) => `  1) ${hash} "${name}"\n`
test('uses a stable existing development identity without ad-hoc fallback', () => {
    assert.deepEqual(choosePreviewSigningIdentity(row(dev, 'Apple Development: Preview (TEAM)')),
        { hash: dev, name: 'Apple Development: Preview (TEAM)', type: 'development' })
    assert.throws(() => choosePreviewSigningIdentity('0 valid identities found'), /No stable/)
})
test('ignores installer and unrelated identities and prefers Developer ID for desktop builds', () => {
    const listing = row(dev, 'Apple Development: Preview (TEAM)') + row(dist, 'Developer ID Application: Preview (TEAM)') + row('C'.repeat(40), 'Developer ID Installer: Preview (TEAM)')
    assert.equal(choosePreviewSigningIdentity(listing).hash, dist)
    assert.equal(choosePreviewSigningIdentity(listing, dev.toLowerCase()).hash, dev)
})
test('does not silently select a different certificate or fall back when a requested identity is missing', () => {
    const listing = row(dev, 'Apple Development: First (TEAM)') + row(dist, 'Apple Development: Second (OTHER)')
    assert.throws(() => choosePreviewSigningIdentity(listing), /More than one/)
    assert.throws(() => choosePreviewSigningIdentity(listing, 'missing'), /not uniquely available/)
    assert.equal(choosePreviewSigningIdentity(listing, 'Apple Development: Second (OTHER)').hash, dist)
})

test('preserves the installed signer when a new distribution certificate becomes available', () => {
    const name = 'Apple Development: Preview (TEAM)'
    const listing = row(dev, name) + row(dist, 'Developer ID Application: Other (OTHER)')
    assert.equal(choosePreviewSigningIdentity(listing, undefined, name).hash, dev)
    assert.throws(() => choosePreviewSigningIdentity(row(dist, 'Developer ID Application: Other (OTHER)'), undefined, name), /installed preview signing certificate/)
    assert.equal(choosePreviewSigningIdentity(listing, dist, name).hash, dist)
})

test('an App Store development build selects a Mac profile and its authorized signing certificate', () => {
    const certificate = Buffer.from('synthetic development certificate')
    const fingerprint = createHash('sha1').update(certificate).digest('hex').toUpperCase()
    const appIdentifier = 'SYNTHETIC1.build.rerun.desktop.preview'
    const profile = {
        Platform: ['OSX'], ProvisionedDevices: ['registered-mac'], ExpirationDate: new Date('2031-01-01T00:00:00Z'),
        DeveloperCertificates: [certificate],
        Entitlements: { 'com.apple.developer.team-identifier': 'SYNTHETIC1', 'com.apple.application-identifier': appIdentifier },
    }
    const listing = row(fingerprint, 'Apple Development: Allowed (SYNTHETIC1)') + row(dev, 'Apple Development: Unlisted (SYNTHETIC1)')
    const now = Date.parse('2030-01-01T00:00:00Z')
    assert.deepEqual(selectMasDevelopmentIdentity(profile, listing, undefined, now), { identity: fingerprint, appIdentifier })
    assert.throws(() => selectMasDevelopmentIdentity(profile, listing, dev, now), /not uniquely available/)
    assert.throws(() => selectMasDevelopmentIdentity(profile, row(fingerprint, 'Apple Distribution: Wrong type'), undefined, now), /No available Apple Development/)
    for (const wrong of [
        { Platform: ['iOS'] }, { ProvisionedDevices: [] }, { ExpirationDate: new Date(now) },
        { Entitlements: { ...profile.Entitlements, 'com.apple.application-identifier': 'SYNTHETIC1.other.app' } },
    ]) {
        assert.throws(() => selectMasDevelopmentIdentity({ ...profile, ...wrong }, listing, undefined, now), /Mac development provisioning profile/)
    }
})
