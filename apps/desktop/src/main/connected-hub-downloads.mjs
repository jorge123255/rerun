import { randomUUID } from 'node:crypto'
import { linkSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { sameHub } from './connected-hub-policy.mjs'

function limitBytes(value, limit) {
    let result = '', length = 0
    for (const character of value) {
        length += Buffer.byteLength(character)
        if (length > limit) break
        result += character
    }
    return result
}

export function safeHubDownloadName(value) {
    const raw = typeof value === 'string' ? value : ''
    const filename = basename(raw.replace(/\\/g, '/')).normalize('NFC')
        .replace(/[<>:"|?*\p{Cc}\p{Cf}]/gu, '_').trim().replace(/^\.+/, '').trim()
    const extension = extname(filename)
    const suffix = Buffer.byteLength(extension) <= 24 ? extension : ''
    const stem = suffix ? filename.slice(0, -suffix.length) : filename
    return limitBytes(stem, 200 - Buffer.byteLength(suffix)).trimEnd() + suffix || 'download'
}

export function isHubDownload(chain, origin) {
    if (!Array.isArray(chain) || !chain.length) return false
    return chain.every(url => {
        if (sameHub(url, origin)) return true
        try {
            return chain.length === 1 && url.startsWith('blob:') && new URL(url).origin === origin
        } catch { return false }
    })
}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino
function ownedDirectory(path, saved) {
    const current = lstatSync(path)
    return current.isDirectory() && sameFile(current, saved) && realpathSync(path) === path
}
function discard(temporary) {
    if (!temporary) return
    try {
        if (!ownedDirectory(temporary.directory, temporary.directoryInfo)) return
        for (const path of [temporary.file, temporary.file + '.crdownload']) {
            try { unlinkSync(path) } catch { /* Chromium may already have removed it. */ }
        }
        rmdirSync(temporary.directory)
    } catch { /* A partial download is never published or revealed. */ }
}
function prepare(root) {
    const directory = mkdtempSync(join(root, '.rerun-download-'))
    return { directory, directoryInfo: lstatSync(directory), file: join(directory, 'transfer') }
}
function publish(root, rootInfo, temporary, filename) {
    if (!ownedDirectory(root, rootInfo) || !ownedDirectory(temporary.directory, temporary.directoryInfo)) throw new Error('Download location changed')
    const file = lstatSync(temporary.file)
    if (!file.isFile() || file.nlink !== 1) throw new Error('Download is not a regular file')
    const extension = extname(filename)
    const stem = filename.slice(0, filename.length - extension.length)
    for (let index = 0; index < 10000; index++) {
        const name = index === 0 ? filename : `${stem} (${index})${extension}`
        const path = join(root, name)
        try {
            // Publish the complete file atomically. A simultaneous download or a
            // symlink at the destination cannot overwrite an existing file.
            linkSync(temporary.file, path)
            return { path, file, root, rootInfo, filename: name }
        } catch (error) {
            if (error.code !== 'EEXIST') throw error
        }
    }
    throw new Error('No unused download name')
}

export function createHubDownloads({ app, shell, ownerOf, notify, closeEmptyWindow, now = Date.now }) {
    const tracked = new WeakSet()
    const active = new Map()
    const completed = new Map()

    function track(session) {
        if (tracked.has(session)) return
        tracked.add(session)
        session.on('will-download', (event, item, contents) => {
            const owner = ownerOf(contents)
            if (!owner || owner.contents.session !== session || !isHubDownload(item.getURLChain(), owner.origin)) {
                event.preventDefault()
                return
            }
            const id = randomUUID(), filename = safeHubDownloadName(item.getFilename())
            const report = (state, name = filename) => notify(owner, { id, filename: name, state,
                receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes() })
            let root, rootInfo, temporary
            try {
                root = realpathSync(app.getPath('downloads'))
                rootInfo = lstatSync(root)
                if (!rootInfo.isDirectory()) throw new Error('Downloads is unavailable')
                temporary = prepare(root)
                item.setSavePath(temporary.file)
            } catch {
                event.preventDefault()
                discard(temporary)
                report('interrupted')
                closeEmptyWindow?.(contents)
                return
            }

            let lastReport = now()
            active.set(item, temporary)
            item.on('updated', (_event, state) => {
                if (!active.has(item)) return
                if (state === 'interrupted') {
                    report('interrupted')
                    return
                }
                if (state !== 'progressing' || now() - lastReport < 250) return
                lastReport = now()
                report('progressing')
            })
            item.once('done', (_event, state) => {
                if (!active.delete(item)) return
                let saved
                try { if (state === 'completed') saved = publish(root, rootInfo, temporary, filename) } catch {}
                finally { discard(temporary) }
                if (saved) {
                    completed.set(id, { ...saved, owner })
                    if (completed.size > 128) completed.delete(completed.keys().next().value)
                    try { app.addRecentDocument(saved.path); app.dock?.downloadFinished(saved.path) } catch {}
                    report('completed', saved.filename)
                } else report(state === 'cancelled' ? 'cancelled' : 'interrupted')
                closeEmptyWindow?.(contents)
            })
            report('progressing')
        })
    }

    return {
        track,
        show(owner, id) {
            if (typeof id !== 'string' || id.length !== 36) return
            const saved = completed.get(id)
            if (saved?.owner !== owner) return
            try {
                if (!ownedDirectory(saved.root, saved.rootInfo)) return
                const file = lstatSync(saved.path)
                if (file.isFile() && sameFile(file, saved.file)) shell.showItemInFolder(saved.path)
            } catch { /* The file may have been moved or deleted. */ }
        },
        cancelAll() {
            for (const [item, temporary] of active) {
                try { item.cancel() } catch {}
                if (active.delete(item)) discard(temporary)
            }
        },
    }
}
