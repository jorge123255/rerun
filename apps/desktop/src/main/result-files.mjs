import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

const RESULT_MAX_BYTES = 16 * 1024 * 1024
// Match the desktop coworker file import limit.
const COWORKER_MAX_BYTES = 100 * 1024 * 1024

function validName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= 255
        && !name.startsWith('.') && !/[\\/\p{Cc}]/u.test(name)
}

async function fetchWorkspaceBytes(fetchFile, original, pathname, params, limit, label, check, headers = {}) {
    const url = new URL(pathname, original.runtime.app.origin)
    url.search = new URLSearchParams(params).toString()
    const signal = AbortSignal.timeout(30_000)
    const response = await fetchFile(url, {
        headers: { Cookie: `rerun-desktop-session=${original.runtime.app.sessionToken}` },
        cache: 'no-store',
        redirect: 'error',
        signal,
    }).catch(() => { throw new Error(`Could not read this ${label} file.`) })
    const length = response.headers.get('content-length')
    const size = length !== null && /^\d+$/.test(length) ? Number(length) : NaN
    if (!response.ok || response.headers.get('content-type') !== 'application/octet-stream'
        || !Number.isSafeInteger(size) || size > limit || !response.body
        || Object.entries(headers).some(([name, expected]) => response.headers.get(name) !== expected)) {
        await response.body?.cancel().catch(() => {})
        if (response.status === 409) throw new Error('This file changed. Reopen it in Files before saving.')
        if (response.status === 404) throw new Error('This file was not found.')
        if (response.status === 413 || size > limit) throw new Error(`Files can be up to ${limit / (1024 * 1024)} MiB.`)
        throw new Error(`Could not read this ${label} file.`)
    }
    const reader = response.body.getReader()
    try {
        check()
        const bytes = new Uint8Array(size)
        let offset = 0
        for (;;) {
            const { done, value } = await reader.read().catch(() => { throw new Error(`Could not finish reading this ${label} file.`) })
            check()
            if (done) break
            if (value.byteLength > size - offset) throw new Error(`Could not confirm this ${label} file’s length.`)
            bytes.set(value, offset)
            offset += value.byteLength
        }
        if (offset !== size) throw new Error(`Could not confirm this ${label} file’s length.`)
        return bytes
    } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
    }
}

export function createDesktopFileSaves({ dialog, context, fetchFile = fetch }) {
    let busy = false

    async function saveFile(name, loadBytes, workspaceId) {
        if (busy) throw new Error('Finish the open Save dialog first.')
        busy = true
        try {
            const original = context()
            const check = () => {
                const current = context()
                if (!original?.runtime || (workspaceId !== undefined && original.runtime.workspaceId !== workspaceId)
                    || current?.runtime !== original.runtime || current?.window !== original.window) throw new Error('The workspace changed. Open the file again.')
            }
            check()
            const picked = await dialog.showSaveDialog(original.window, { title: 'Save file', defaultPath: name })
            check()
            if (picked.canceled || !picked.filePath) return false
            const before = await lstat(picked.filePath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
            if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) throw new Error('Choose a regular file location.')
            check()
            const bytes = await loadBytes(original, check)
            check()
            const file = await open(picked.filePath, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (before ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
            try {
                const current = await file.stat()
                if (!current.isFile() || current.nlink !== 1 || (before && (current.dev !== before.dev || current.ino !== before.ino
                    || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs))) {
                    throw new Error('The destination changed. Save the file again.')
                }
                check()
                await file.truncate(0)
                await file.writeFile(bytes)
                await file.sync()
                return true
            } finally { await file.close() }
        } finally { busy = false }
    }

    return {
        async saveResultFile(value) {
            if (!value || Object.keys(value).some(key => key !== 'name' && key !== 'bytes') || !validName(value.name)
                || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength > RESULT_MAX_BYTES) throw new Error('Choose a supported result file.')
            const bytes = new Uint8Array(value.bytes)
            return saveFile(value.name, () => bytes)
        },
        async saveCoworkerFile(value) {
            const { agentId, path, version } = value ?? {}
            if (!value || Object.keys(value).some(key => key !== 'agentId' && key !== 'path' && key !== 'version')
                || typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(agentId)
                || typeof path !== 'string' || path.length > 4096
                || typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) throw new Error('Choose a file from Coworker Files.')
            const parts = path.split('/')
            const name = parts.at(-1)
            if (!validName(name) || parts.length > 64 || parts.some(part => !part || part === '.' || part === '..' || /[\\\p{Cc}]/u.test(part))) {
                throw new Error('Choose a file from Coworker Files.')
            }
            return saveFile(name, (original, check) => fetchWorkspaceBytes(fetchFile, original,
                `/api/desktop/agents/${encodeURIComponent(agentId)}/files/download`, { path, version }, COWORKER_MAX_BYTES, 'coworker', check))
        },
        async saveSharedFile(value) {
            const { workspaceId, path, version, identity } = value ?? {}
            const digest = /^[a-f0-9]{64}$/
            if (!value || Object.keys(value).some(key => !['workspaceId', 'path', 'version', 'identity'].includes(key))
                || !Number.isSafeInteger(workspaceId) || workspaceId < 1 || typeof path !== 'string' || path.length > 4096
                || typeof version !== 'string' || !digest.test(version)
                || (identity !== undefined && (typeof identity !== 'string' || !digest.test(identity)))) {
                throw new Error('Choose a file from Shared Files.')
            }
            const parts = path.split('/')
            if (parts.length > 32 || !parts.every(validName)) throw new Error('Choose a file from Shared Files.')
            const params = { workspaceId, path, version, ...(identity !== undefined && { identity }) }
            const headers = { 'x-rerun-shared-version': version, ...(identity !== undefined && { 'x-rerun-shared-sha256': identity }) }
            return saveFile(parts.at(-1), (original, check) => fetchWorkspaceBytes(fetchFile, original,
                '/api/desktop/shared-files/download', params, RESULT_MAX_BYTES, 'shared', check, headers), workspaceId)
        },
    }
}

export function createDesktopResultFileSave(options) {
    return createDesktopFileSaves(options).saveResultFile
}
