import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'

export function createDesktopResultFileSave({ dialog, context }) {
    let busy = false
    return async value => {
        if (!value || Object.keys(value).some(key => key !== 'name' && key !== 'bytes') || typeof value.name !== 'string'
            || !value.name || value.name.length > 255 || value.name.startsWith('.') || /[\\/\p{Cc}]/u.test(value.name)
            || !(value.bytes instanceof Uint8Array) || value.bytes.byteLength > 16 * 1024 * 1024) throw new Error('Choose a supported result file.')
        if (busy) throw new Error('Finish the open Save dialog first.')
        busy = true
        try {
            const original = context()
            const check = () => {
                const current = context()
                if (!original?.runtime || current?.runtime !== original.runtime || current?.window !== original.window) throw new Error('The workspace changed. Open the file again.')
            }
            check()
            const bytes = new Uint8Array(value.bytes)
            const picked = await dialog.showSaveDialog(original.window, { title: 'Save file', defaultPath: value.name })
            check()
            if (picked.canceled || !picked.filePath) return false
            const before = await lstat(picked.filePath).catch(error => { if (error.code === 'ENOENT') return null; throw error })
            if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) throw new Error('Choose a regular file location.')
            check()
            const file = await open(picked.filePath, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (before ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600)
            try {
                const current = await file.stat()
                if (!current.isFile() || current.nlink !== 1 || (before && (current.dev !== before.dev || current.ino !== before.ino))) throw new Error('The destination changed. Save the file again.')
                check()
                await file.truncate(0)
                await file.writeFile(bytes)
                await file.sync()
                return true
            } finally { await file.close() }
        } finally { busy = false }
    }
}
