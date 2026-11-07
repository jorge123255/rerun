import type { FilesImportItem, FilesImportSaved, FilesImportWriteRequest, FilesImportWriter } from './types'

/**
 * Files panel mount. Root applies this in `DesktopCoworkerFiles`.
 * Do not point the chat composer here. Do not register a new route in this package.
 *
 * The single-file control to leave in place until this mount replaces it:
 * `apps/ui/components/desktop/DesktopCoworkerFiles.tsx` input `accept=".txt,.md,text/plain,text/markdown"`.
 * `importCoworkerFile` and `POST /api/desktop/agents/:agentId/files` stay the one-file text path.
 *
 * Writer, in the desktop server, not in the browser bundle:
 * `publishFilesImport(workspaceRoot, request.path, request.bytes, request.signal, request.onProgress)`
 * from `apps/engine/src/desktop/files-import`. `workspaceRoot` is the coworker's canonical
 * `…/agents/<engineAgentId>/workspace`. This package does not look up the roster.
 */
export type FilesImportPanelMount = {
    component: 'FilesImportSurface'
    rootDir: string
    disabled: boolean
    write: FilesImportWriter
    onFileSaved?: (item: FilesImportItem) => void
    onRejected?: (message: string) => void
}

export type FilesImportServerPublish = (
    workspaceRoot: string,
    request: FilesImportWriteRequest,
) => Promise<FilesImportSaved>

export function filesImportWriter(publish: FilesImportServerPublish, workspaceRoot: string): FilesImportWriter {
    return request => publish(workspaceRoot, request)
}
