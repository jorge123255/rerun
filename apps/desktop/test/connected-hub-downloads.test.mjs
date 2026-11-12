import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHubDownloads, isHubDownload, safeHubDownloadName } from '../src/main/connected-hub-downloads.mjs'

const origin = 'https://hub.example.test'

function fixture(t) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'rerun-hub-downloads-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const session = new EventEmitter()
    const owner = { origin, contents: { session } }, another = { origin, contents: { session } }
    const messages = [], revealed = [], recent = []
    const downloads = createHubDownloads({
        app: { getPath: () => root, addRecentDocument: path => recent.push(path) },
        shell: { showItemInFolder: path => revealed.push(path) },
        ownerOf: contents => contents === owner.contents ? owner : null,
        notify: (source, value) => messages.push({ source, ...value }),
    })
    downloads.track(session)
    downloads.track(session)
    function begin({ filename = 'export.csv', urls = [origin + '/export'], contents = owner.contents } = {}) {
        let refused = false
        const item = Object.assign(new EventEmitter(), {
            getURLChain: () => urls, getFilename: () => filename,
            getReceivedBytes: () => 12, getTotalBytes: () => 12,
            setSavePath(path) { this.destination = path },
            cancel() { this.emit('done', null, 'cancelled') },
        })
        session.emit('will-download', { preventDefault() { refused = true } }, item, contents)
        return { item, refused }
    }
    return { root, owner, another, messages, revealed, recent, downloads, begin }
}

test('server filenames stay within one bounded leaf and foreign URL chains are refused', () => {
    assert.equal(safeHubDownloadName('..\\other\\.draft.csv'), 'draft.csv')
    assert.equal(safeHubDownloadName('..'), 'download')
    assert.equal(safeHubDownloadName('a\n\u202eb.csv'), 'a__b.csv')
    const long = safeHubDownloadName('é'.repeat(300) + '.pdf')
    assert(Buffer.byteLength(long) <= 200 && long.endsWith('.pdf'))
    assert(isHubDownload([origin + '/first', origin + '/second'], origin))
    assert(isHubDownload(['blob:' + origin + '/identifier'], origin))
    for (const chain of [[origin + '/first', 'https://other.test/export'], ['blob:https://other.test/id'], ['file:///tmp/test'], ['data:text/plain,test'], []]) {
        assert.equal(isHubDownload(chain, origin), false)
    }
})

test('simultaneous downloads preserve prior files and symlinks, and reveal belongs to the initiating window', t => {
    const f = fixture(t)
    const existing = join(f.root, 'export.csv')
    writeFileSync(existing, 'original')
    symlinkSync(existing, join(f.root, 'export (1).csv'))
    const { item: first } = f.begin()
    const { item: second } = f.begin()
    assert.notEqual(first.destination, second.destination)
    writeFileSync(first.destination, 'first exact bytes')
    writeFileSync(second.destination, 'second exact bytes')
    first.emit('done', null, 'completed')
    second.emit('done', null, 'completed')
    assert.equal(readFileSync(existing, 'utf8'), 'original')
    assert.equal(readFileSync(join(f.root, 'export (1).csv'), 'utf8'), 'original')
    assert.equal(readFileSync(join(f.root, 'export (2).csv'), 'utf8'), 'first exact bytes')
    assert.equal(readFileSync(join(f.root, 'export (3).csv'), 'utf8'), 'second exact bytes')
    assert(!readdirSync(f.root).some(name => name.startsWith('.rerun-download-')))
    assert.deepEqual(f.messages.map(value => value.state), ['progressing', 'progressing', 'completed', 'completed'])
    assert.deepEqual(f.recent, [join(f.root, 'export (2).csv'), join(f.root, 'export (3).csv')])
    const { id } = f.messages.at(-1)
    f.downloads.show(f.another, id)
    assert.deepEqual(f.revealed, [])
    f.downloads.show(f.owner, id)
    assert.deepEqual(f.revealed, [join(f.root, 'export (3).csv')])
    unlinkSync(join(f.root, 'export (3).csv'))
    symlinkSync(existing, join(f.root, 'export (3).csv'))
    f.downloads.show(f.owner, id)
    assert.equal(f.revealed.length, 1)
})

test('a foreign sender, a foreign redirect and a cancelled transfer publish nothing', t => {
    const f = fixture(t)
    assert.equal(f.begin({ contents: f.another.contents }).refused, true)
    assert.equal(f.begin({ urls: [origin + '/export', 'https://other.test/export'] }).refused, true)
    const { item } = f.begin()
    writeFileSync(item.destination, 'partial')
    f.downloads.cancelAll()
    assert.deepEqual(readdirSync(f.root), [])
    assert.deepEqual(f.messages.map(value => value.state), ['progressing', 'cancelled'])
    assert.deepEqual(f.recent, [])
})
