import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const MAX_BYTES = 160 * 1024 * 1024
const artifactId = /^[a-f0-9]{32}$/
const digest = /^[a-f0-9]{64}$/
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\\/\p{Cc}]/u.test(value)
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino

async function boundedResponse(response, maximum, check) {
    if (!response.ok || !response.body) throw new Error('The template file is unavailable. Try again.')
    const declared = response.headers.get('content-length')
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error('The template file is too large.')
    const reader = response.body.getReader()
    const chunks = []
    let length = 0
    try {
        while (true) {
            check()
            const next = await reader.read()
            check()
            if (next.done) break
            length += next.value.length
            if (length > maximum) throw new Error('The template file is too large.')
            chunks.push(Buffer.from(next.value))
        }
        if (declared && length !== Number(declared)) throw new Error('The template file was incomplete. Try again.')
        return Buffer.concat(chunks, length)
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function createDesktopTemplateFiles({ dialog, context, fetch: request = fetch }) {
    let busy = false
    async function run(work) {
        if (busy) throw new Error('Finish the open template file dialog first.')
        busy = true
        try {
            const initial = context()
            const check = () => {
                const current = context()
                if (!initial?.runtime || current?.runtime !== initial.runtime || current.window !== initial.window) throw new Error('The workspace changed. Reopen the template library.')
            }
            check()
            const engine = initial.runtime.engine
            const origin = new URL(engine.origin)
            if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new Error('The local template service is unavailable.')
            const call = (path, options = {}) => request(new URL(`/desktop/templates/${path}`, origin), {
                ...options, redirect: 'error', signal: AbortSignal.timeout(120_000),
                headers: { ...options.headers, Authorization: `Bearer ${engine.apiKey}` },
            })
            return await work({ window: initial.window, check, call })
        } finally { busy = false }
    }
    return {
        pickImport() {
            return run(async ({ window, check, call }) => {
                const picked = await dialog.showOpenDialog(window, { title: 'Import template package', properties: ['openFile'], filters: [{ name: 'Rerun template package', extensions: ['gz'] }] })
                check()
                if (picked.canceled) return null
                if (picked.filePaths.length !== 1) throw new Error('Choose one template package.')
                const path = picked.filePaths[0]
                const fileName = basename(path)
                if (!safeName(fileName)) throw new Error('Rename the package before importing it.')
                const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
                let bytes
                try {
                    const before = await handle.stat()
                    if (!before.isFile() || before.size < 24 || before.size > MAX_BYTES) throw new Error('Choose a template package smaller than 160 MB.')
                    bytes = Buffer.alloc(before.size)
                    let offset = 0
                    while (offset < bytes.length) {
                        check()
                        const read = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset)
                        if (!read.bytesRead) throw new Error('The selected package changed. Choose it again.')
                        offset += read.bytesRead
                    }
                    const after = await handle.stat()
                    if (!sameFile(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('The selected package changed. Choose it again.')
                } finally { await handle.close() }
                check()
                const uploadId = randomUUID()
                const response = await call(`uploads/${uploadId}`, { method: 'POST', headers: { 'Content-Type': 'application/gzip', 'x-template-filename': encodeURIComponent(fileName) }, body: bytes })
                const result = JSON.parse((await boundedResponse(response, 4096, check)).toString('utf8'))
                if (result.uploadId !== uploadId || result.fileName !== fileName || result.bytes !== bytes.length) throw new Error('The template upload could not be confirmed. Try again.')
                return { uploadId, fileName, bytes: bytes.length }
            })
        },
        saveArtifact(value) {
            if (!value || Object.keys(value).length !== 1 || !artifactId.test(value.artifactId)) return Promise.reject(new Error('Invalid template download.'))
            return run(async ({ window, check, call }) => {
                const info = JSON.parse((await boundedResponse(await call(`artifacts/${value.artifactId}`), 4096, check)).toString('utf8'))
                if (info.artifactId !== value.artifactId || !safeName(info.fileName) || !Number.isSafeInteger(info.bytes) || info.bytes < 24 || info.bytes > MAX_BYTES || !digest.test(info.archiveDigest)) throw new Error('The template download receipt is invalid.')
                const picked = await dialog.showSaveDialog(window, { title: 'Export template package', defaultPath: info.fileName, filters: [{ name: 'Rerun template package', extensions: ['gz'] }] })
                check()
                if (picked.canceled || !picked.filePath) return { saved: false }
                const bytes = await boundedResponse(await call(`artifacts/${value.artifactId}/content`), MAX_BYTES, check)
                if (bytes.length !== info.bytes || createHash('sha256').update(bytes).digest('hex') !== info.archiveDigest) throw new Error('The template download changed. Try again.')
                const previous = await lstat(picked.filePath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
                if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) throw new Error('Choose a regular file location for this package.')
                check()
                const handle = await open(picked.filePath, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (previous ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
                try {
                    const current = await handle.stat()
                    if (!current.isFile() || current.nlink !== 1 || (previous && !sameFile(previous, current))) throw new Error('The chosen destination changed. Save the package again.')
                    check()
                    await handle.truncate(0)
                    await handle.writeFile(bytes)
                    await handle.sync()
                } finally { await handle.close() }
                return { saved: true }
            })
        },
    }
}
