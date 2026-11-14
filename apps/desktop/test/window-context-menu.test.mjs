import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { attachDesktopContextMenu, externalDesktopLink } from '../src/main/window-context-menu.mjs'
import { isHubDownload } from '../src/main/connected-hub-downloads.mjs'

function fixture(locale = 'en-US', extras = {}) {
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
        clipboard: { writeText: text => calls.push(['copy-link', text]) }, openExternal: url => calls.push(['open', url]), ...extras })
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

test('Save Image sits beside Copy Image only for a displayed board image and a stale menu does not save', async () => {
    const saved = []
    const failures = []
    const { emit, item, menus, calls, setScope } = fixture('fr-CA', {
        saveImage: (pageURL, srcURL) => { saved.push([pageURL, srcURL]); return false },
        reportFailure: error => failures.push(error),
    })
    const page = 'http://127.0.0.1:51329/desktop'
    const src = 'http://127.0.0.1:51329/api/desktop/agents/local-owner/files/image?path=reports%2Fchart+one.png&animation=1&workspaceOwner=engine-owner'
    emit({ mediaType: 'image', hasImageContents: false, srcURL: src })
    emit({ mediaType: 'image', hasImageContents: true, srcURL: 'blob:http://127.0.0.1:51329/11111111-1111-1111-1111-111111111111' })
    emit({ mediaType: 'image', hasImageContents: true, srcURL: 'https://example.test/chart.png' })
    emit({ mediaType: 'image', hasImageContents: true, srcURL: 'http://127.0.0.1:51329/api/desktop/agents/local-owner/files/image?path=diagram.svg&animation=1' })
    emit({ mediaType: 'image', hasImageContents: true, srcURL: src, frame: {} })
    assert.equal(menus.length, 3)
    for (const menu of menus) assert.equal(menu.some(entry => entry.id === 'rerun-context-save-image'), false)
    emit({ mediaType: 'image', hasImageContents: true, srcURL: src, x: 8, y: 9 })
    assert.deepEqual(menus.at(-1).map(entry => entry.id), ['rerun-context-copy-image', 'rerun-context-save-image'])
    assert.equal(item('save-image').label, 'Enregistrer l’image')
    item('copy-image').click()
    item('save-image').click()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, [['image', 8, 9]])
    assert.deepEqual(saved, [[page, src]])
    assert.deepEqual(failures, [])
    const stale = item('save-image')
    setScope('another-renderer')
    stale.click()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(saved, [[page, src]])
})

test('a failed Save Image reports the failure and cancellation does not', async () => {
    let fail = true
    const failures = []
    const { emit, item } = fixture('en-US', {
        saveImage: () => fail ? Promise.reject(new Error('The workspace changed. Open the file again.')) : false,
        reportFailure: error => failures.push(error),
    })
    const src = 'http://127.0.0.1:51329/api/desktop/shared-files/media?path=reports%2Fteam.png'
    emit({ mediaType: 'image', hasImageContents: true, srcURL: src })
    item('save-image').click()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(failures.length, 1)
    assert.equal(failures[0].message, 'The workspace changed. Open the file again.')
    fail = false
    item('save-image').click()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(failures.length, 1)
})

test('hosted Save Image uses the displayed hub URL and refuses foreign and stale targets', () => {
    const origin = 'https://hub.example.test'
    const saved = [], errors = []
    const { emit, item, contents, setScope } = fixture('en-US', {
        canSaveImage: (_page, src) => isHubDownload([src], origin),
        saveImage: (page, src) => { saved.push([page, src]); throw new Error('Download refused') },
        reportFailure: error => errors.push(error.message),
    })
    const page = origin + '/board'
    contents.mainFrame.url = page
    emit({ mediaType: 'image', hasImageContents: true, srcURL: 'https://cdn.example.test/chart.png' })
    assert(item('copy-image'))
    assert.equal(item('save-image'), undefined)
    const source = origin + '/chart.png?version=1'
    emit({ mediaType: 'image', hasImageContents: true, srcURL: source })
    const save = item('save-image')
    save.click()
    assert.deepEqual(saved, [[page, source]])
    assert.deepEqual(errors, ['Download refused'])
    setScope('new-document')
    save.click()
    assert.equal(saved.length, 1)
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
