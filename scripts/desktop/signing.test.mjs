import assert from 'node:assert/strict'
import { test } from 'node:test'
import { choosePreviewSigningIdentity } from './signing.mjs'

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
