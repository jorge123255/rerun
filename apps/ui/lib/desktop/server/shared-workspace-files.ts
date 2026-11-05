import 'server-only'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'
export { SHARED_IMPORT_BYTES } from '../../../../engine/src/desktop/shared-workspace-files'
import {
    importSharedText,
    listSharedDirectory,
    readSharedText,
    resolveDesktopSharedDirectory,
    SharedWorkspaceFileError,
    type SharedDirectoryListing,
    type SharedFileAccess,
    type SharedImportResult,
    type SharedTextPage,
} from '../../../../engine/src/desktop/shared-workspace-files'

// Workspace shared text. The root is always `<dataRoot>/workspaces/1/engine/shared`.
// Requests cannot choose a root, an engine id, or a private workspace.

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

function failure(error: unknown): never {
    if (error instanceof DesktopHttpError) throw error
    if (error instanceof SharedWorkspaceFileError) throw new DesktopHttpError(error.status, error.message)
    if (isAbort(error)) throw new DesktopHttpError(499, 'This request was cancelled. Refresh Shared files before trying again.')
    if (error instanceof Error && error.name === 'TimeoutError') throw new DesktopHttpError(408, 'Shared files took too long to respond. Refresh before trying again.')
    throw new DesktopHttpError(500, 'Shared files could not be opened.')
}

async function sharedDirectory(runtime: DesktopRuntime, signal?: AbortSignal): Promise<string> {
    try { return await resolveDesktopSharedDirectory(runtime.dataRoot, signal) }
    catch (error) { failure(error) }
}

export async function listDesktopSharedFiles(runtime: DesktopRuntime, path: string, access?: SharedFileAccess): Promise<SharedDirectoryListing> {
    try { return await listSharedDirectory(await sharedDirectory(runtime, access?.signal), path, access) }
    catch (error) { failure(error) }
}

export async function readDesktopSharedFile(runtime: DesktopRuntime, path: string, offset = 0, access?: SharedFileAccess): Promise<SharedTextPage> {
    try { return await readSharedText(await sharedDirectory(runtime, access?.signal), path, offset, access) }
    catch (error) { failure(error) }
}

export async function importDesktopSharedFile(runtime: DesktopRuntime, folder: string, name: string, bytes: Uint8Array, access?: SharedFileAccess): Promise<SharedImportResult> {
    try { return await importSharedText(await sharedDirectory(runtime, access?.signal), folder, name, bytes, access) }
    catch (error) { failure(error) }
}
