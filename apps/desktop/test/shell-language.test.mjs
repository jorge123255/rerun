import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadShellLanguage, shellLocale, shellText } from '../src/main/shell-language.mjs'

test('Mac menus use a supported system language and only apply the active scope', async t => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'rerun-shell-language-'))
    t.after(() => rm(dataRoot, { recursive: true, force: true }))
    let scope = 'local'
    let changes = 0
    const load = () => loadShellLanguage({
        dataRoot, systemLanguages: ['ja-JP', 'fr-CA', 'en'], currentScope: () => scope, onChange: () => changes++,
    })
    const language = await load()
    assert.equal(language.locale(), 'fr')
    language.set('local', 'pt-BR')
    assert.equal(language.locale(), 'pt')
    language.set('https://hub.example', 'de')
    language.set('local', 'unknown')
    assert.equal(language.locale(), 'pt')
    assert.equal(language.forScope('https://hub.example'), 'de')
    scope = 'https://hub.example'
    language.select(scope)
    assert.equal(language.locale(), 'de')
    assert.equal(changes, 2)
    await language.flush()
    assert.equal((await load()).locale(), 'de')
    scope = 'local'
    language.select(scope)
    assert.equal(language.locale(), 'pt')
    await language.flush()
})

test('Mac strings use the upstream packs and interpolate the app name', () => {
    assert.equal(shellText('fr-CA')('menu.view.reload'), 'Recharger')
    assert.match(shellText('es')('menu.app.quit', { name: 'Rerun Preview' }), /Rerun Preview/)
    assert.equal(shellText('xx')('menu.view.reload'), 'Reload')
    for (const value of [null, '', {}, '../../de', 'fr;en', 'fr-CA-foo', 'es_419']) assert.equal(shellLocale(value), null)
})

test('Keychain startup guidance follows the selected Mac language', () => {
    const english = shellText('en')
    assert.match(english('startup.keychainPrompt'), /Keychain access/)
    assert.match(english('startup.keychainBlocked'), /Unlock your login Keychain/)
    for (const locale of ['de', 'es', 'fr', 'pt']) {
        const translated = shellText(locale)
        assert.notEqual(translated('startup.keychainPrompt'), english('startup.keychainPrompt'))
        assert.notEqual(translated('startup.keychainBlocked'), english('startup.keychainBlocked'))
    }
})
