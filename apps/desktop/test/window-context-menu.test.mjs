import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { attachDesktopContextMenu, externalDesktopLink } from '../src/main/window-context-menu.mjs'

function fixture(locale = 'en-US') {
    const frame = { url: 'http://127.0.0.1:51329/desktop' }
    let scope = 'renderer-epoch'
    const calls = [], menus = []
    const contents = Object.assign(new EventEmitter(), {
        mainFrame: frame,
        session: { addWordToSpellCheckerDictionary: word => calls.push(['dictionary', word]) },
        replaceMisspelling: word => calls.push(['spell', word]),
        cut: () => calls.push(['cut']), copy: () => calls.push(['copy']),
        paste: () => calls.push(['paste']), selectAll: () => calls.push(['select-all']),
        copyImageAt: (...point) => calls.push(['image', ...point]),
    })
    const window = { webContents: contents }
    const Menu = { buildFromTemplate: items => ({ popup: options => { assert.equal(options.window, window); menus.push(items) } }) }
    attachDesktopContextMenu({ window, Menu, locale, currentScope: () => scope,
        clipboard: { writeText: text => calls.push(['copy-link', text]) }, openExternal: url => calls.push(['open', url]) })
    const emit = (params = {}) => contents.emit('context-menu', {}, {
        frame, pageURL: frame.url, selectionText: '', isEditable: false, spellcheckEnabled: true,
        dictionarySuggestions: [], misspelledWord: '', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
        ...params,
    })
    return { emit, calls, menus, contents, setScope: value => { scope = value },
        item: name => menus.at(-1).find(item => item.id === 'rerun-context-' + name) }
}

test('native editing and spelling use the initiating contents and retain edit flags', () => {
    const { emit, item, calls, menus } = fixture('fr-CA')
    emit({ isEditable: true, formControlType: 'text-area', misspelledWord: 'smaple',
        dictionarySuggestions: ['sample', 'simple', 'scale', 'staple', 'maple', 'sale'] })
    assert.equal(item('paste').label, 'Coller')
    assert.equal(item('suggestion-5'), undefined)
    item('suggestion-0').click()
    item('dictionary').click()
    item('select-all').click()
    assert.deepEqual(calls, [['spell', 'sample'], ['dictionary', 'smaple'], ['select-all']])
    emit({ isEditable: true, formControlType: 'input-password', misspelledWord: 'secret' })
    assert.equal(menus.length, 2)
    assert.equal(item('dictionary'), undefined)
    assert.equal(item('copy').enabled, false)
    item('copy').click()
    assert.equal(calls.length, 3)
})

test('the menu handles approved external links and loaded images and skips the empty board', () => {
    const { emit, item, menus, calls } = fixture()
    for (const url of ['file:///tmp/sample', 'javascript:alert(1)', 'http://127.0.0.1:3210/desktop',
        'https://name:secret@example.test/', 'data:text/html,hello']) {
        assert.equal(externalDesktopLink(url), null)
        emit({ linkURL: url })
    }
    emit()
    assert.equal(menus.length, 0)
    emit({ linkURL: 'https://example.test/path', mediaType: 'image', hasImageContents: true, x: 25, y: 41 })
    item('open-link').click()
    item('copy-link').click()
    item('copy-image').click()
    assert.deepEqual(calls, [
        ['open', 'https://example.test/path'], ['copy-link', 'https://example.test/path'], ['image', 25, 41],
    ])
})

test('subframes and stale menus cannot dispatch after navigation or a new context event', () => {
    const { emit, item, menus, calls, setScope } = fixture()
    emit({ frame: {}, selectionText: 'selection' })
    emit({ pageURL: 'file:///startup.html', selectionText: 'selection' })
    assert.equal(menus.length, 0)
    emit({ selectionText: 'selection' })
    const first = item('copy')
    emit({ selectionText: 'different selection' })
    first.click()
    assert.equal(calls.length, 0)
    const second = item('copy')
    second.click()
    setScope('another-renderer')
    second.click()
    assert.deepEqual(calls, [['copy']])
})
