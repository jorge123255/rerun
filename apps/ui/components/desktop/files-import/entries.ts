import type { UploadEntry } from '@/lib/files/upload'
import type { FilesImportEntry } from './types'

/** Keeps the folder the original picker recorded in `subDir`. Bytes are read only when a job starts. */
export function filesImportEntries(entries: UploadEntry[]): FilesImportEntry[] {
    return entries.map(({ file, subDir }) => ({
        name: file.name,
        subDir,
        size: file.size,
        read: async () => new Uint8Array(await file.arrayBuffer()),
    }))
}
