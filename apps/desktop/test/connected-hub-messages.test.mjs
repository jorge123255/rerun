import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hubConnectionError, hubOfflineCopy, hubPickerCopy, hubRecoveryView } from '../src/main/connected-hub-messages.mjs'

test('bundled connection pages use their supported language and interpolate the hub version', () => {
    for (const locale of ['de', 'en', 'es', 'fr', 'pt']) {
        assert.equal(hubPickerCopy(locale).locale, locale)
        assert.equal(hubOfflineCopy(locale).locale, locale)
        for (const reason of ['invalid', 'unreachable', 'not-rerun', 'unsupported', 'busy', 'too-old']) {
            const message = hubConnectionError(locale, { reason, minimum: '7.2.1' })
            assert(message && !message.includes('{'))
            assert.equal(message.includes('7.2.1'), reason === 'too-old')
        }
    }
    assert.equal(hubPickerCopy('fr-CA').title, 'Se connecter à Rerun')
    assert.equal(hubPickerCopy('fr-CA').cancel, 'Annuler')
    assert.deepEqual(hubPickerCopy('xx'), hubPickerCopy('en'))
})

test('recovery renders the matching condition while retaining only the retry reason', () => {
    const down = hubRecoveryView('es', { reason: 'unavailable', host: 'rerun.example.com' })
    const offline = hubRecoveryView('es', { reason: 'offline', host: 'rerun.example.com' })
    const old = hubRecoveryView('es', { reason: 'too-old', host: 'rerun.example.com', minimum: '7.2.1' })
    assert.match(down.message, /rerun\.example\.com/)
    assert.notEqual(offline.message, down.message)
    assert.notEqual(offline.title, old.title)
    assert.match(old.message, /7\.2\.1/)
    assert.deepEqual(Object.keys(old), ['reason', 'title', 'message'])
    assert.equal(down.changeServer, undefined)
    assert.equal(offline.changeServer, undefined)
    assert.equal(hubRecoveryView('es', null), null)
    for (const reason of ['not-rerun', 'unsupported']) {
        assert.deepEqual(hubRecoveryView('es', { reason }), {
            reason, title: hubPickerCopy('es').title,
            message: hubConnectionError('es', { reason }), changeServer: 'Cambiar de servidor…',
        })
    }
})
