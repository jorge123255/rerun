import test from 'node:test'
import assert from 'node:assert/strict'
import { desktopMicrophonePermissions } from '../src/main/media-permissions.mjs'

test('microphone access stays bound to the current visible trusted app and audio only', () => {
    const page = 'http://127.0.0.1:12345/desktop'
    const contents = { isDestroyed: () => false, mainFrame: { url: page } }
    let current = { webContents: contents }
    const permissions = desktopMicrophonePermissions({ context: () => current, isDesktopPage: value => value === page })
    const details = { isMainFrame: true, requestingUrl: page, mediaTypes: ['audio'], mediaType: 'audio' }
    const request = (permission = 'media', changes = {}, requester = contents) => {
        let allowed
        permissions.request(requester, permission, value => { allowed = value }, { ...details, ...changes })
        return allowed
    }
    assert.equal(request(), true)
    for (const permission of ['display-capture', 'notifications', 'clipboard-read', 'geolocation']) assert.equal(request(permission), false)
    for (const changes of [{ mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }, { mediaTypes: ['video'] }, { isMainFrame: false }, { requestingUrl: 'https://example.com/' }]) assert.equal(request('media', changes), false)
    assert.equal(request('media', {}, { ...contents }), false)
    assert.equal(permissions.check(contents, 'media', 'http://127.0.0.1:12345', details), true)
    assert.equal(permissions.check(contents, 'media', 'http://127.0.0.1:54321', details), false)
    assert.equal(permissions.check(contents, 'media', 'http://127.0.0.1:12345', { ...details, mediaType: 'video' }), false)
    current = null
    assert.equal(request(), false)
})
