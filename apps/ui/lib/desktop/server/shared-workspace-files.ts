import { canonicalDesktopEngineRoot, readDesktopRuntime } from './runtime'
import 'server-only'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'
import { assertDesktopWorkspaceAdmission } from './workspace-admission'
import { deleteFromPinnedFolder, recoverPinnedFileDeletes } from './coworker-files'
export { SHARED_IMPORT_BYTES, sharedFileImportLimit } from '../../../../engine/src/desktop/shared-workspace-files'
import {
    assertSharedDeleteEntry,
    importSharedFile,
    importSharedText,
    listSharedDirectory,
    readSharedEditorText,
    renameSharedEntry,
    replaceSharedText,
    resolveEngineSharedDirectory,
    sharedFileRevision,
    sharedDeleteParentPath,
    withSharedDeleteFolder,
    SharedWorkspaceFileError,
    type SharedDirectoryListing,
    type SharedFileAccess,
    type SharedImportResult,
    type SharedTextReplacement,
    type SharedTextReplacementResult,
    type SharedTextPage,
} from '../../../../engine/src/desktop/shared-workspace-files'

// Shared text stays in the assigned engine context; legacy workspace 1 retains its path.
// Requests cannot choose a root, an engine id, or a private workspace.

function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
}

export function rethrowDesktopSharedFileError(error: unknown): never {
    if (error instanceof DesktopHttpError) throw error
    if (error instanceof SharedWorkspaceFileError) throw new DesktopHttpError(error.status, error.message)
    if (isAbort(error)) throw new DesktopHttpError(499, 'This request was cancelled. Refresh Shared files before trying again.')
    if (error instanceof Error && error.name === 'TimeoutError') throw new DesktopHttpError(408, 'Shared files took too long to respond. Refresh before trying again.')
    throw new DesktopHttpError(500, 'Shared files could not be opened.')
}

export async function desktopSharedDirectory(runtime: DesktopRuntime, signal?: AbortSignal): Promise<string> {
    try { return await resolveEngineSharedDirectory(await canonicalDesktopEngineRoot(runtime), signal) }
    catch (error) { rethrowDesktopSharedFileError(error) }
}

export async function listDesktopSharedFiles(runtime: DesktopRuntime, path: string, access?: SharedFileAccess): Promise<SharedDirectoryListing> {
    try {
        const root = await desktopSharedDirectory(runtime, access?.signal)
        const options = { ...access, deleteMetadata: true }
        let listing = await listSharedDirectory(root, path, options)
        if (listing.hasPendingDelete && process.env.RERUN_DESKTOP_RENAME_HELPER) {
            const beforeCommit = sharedWorkspaceAdmission(runtime, runtime.workspaceId, access?.signal)
            await withSharedDeleteFolder(root, path, { ...access, beforeCommit }, (folder, rootPin, guard) =>
                recoverPinnedFileDeletes(folder.path, folder.pinned, { ...rootPin, validateEntry: assertSharedDeleteEntry }, guard))
            listing = await listSharedDirectory(root, path, options)
        }
        return { path: listing.path, entries: listing.entries, truncated: listing.truncated }
    } catch (error) { rethrowDesktopSharedFileError(error) }
}

export async function readDesktopSharedFile(runtime: DesktopRuntime, path: string, offset = 0, access?: SharedFileAccess): Promise<SharedTextPage> {
    try { return await readSharedEditorText(await desktopSharedDirectory(runtime, access?.signal), path, offset, access) }
    catch (error) { rethrowDesktopSharedFileError(error) }
}

export async function importDesktopSharedFile(runtime: DesktopRuntime, folder: string, name: string, bytes: Uint8Array, access?: SharedFileAccess): Promise<SharedImportResult> {
    try { return await importSharedText(await desktopSharedDirectory(runtime, access?.signal), folder, name, bytes, access) }
    catch (error) { rethrowDesktopSharedFileError(error) }
}

export async function importDesktopSharedOrdinaryFile(runtime: DesktopRuntime, folder: string, name: string, bytes: Uint8Array, access?: SharedFileAccess & { maxBytes?: number }): Promise<SharedImportResult> {
    try { return await importSharedFile(await desktopSharedDirectory(runtime, access?.signal), folder, name, bytes, access) }
    catch (error) { rethrowDesktopSharedFileError(error) }
}

export async function renameDesktopSharedEntry(runtime: DesktopRuntime, path: string, name: string, signal: AbortSignal, selection?: { workspaceId: number; revision: string }): Promise<SharedImportResult> {
    const beforeCommit = sharedWorkspaceAdmission(runtime, selection?.workspaceId ?? runtime.workspaceId, signal)
    try {
        await beforeCommit()
        return await renameSharedEntry(await desktopSharedDirectory(runtime, signal), path, name, {
            signal, beforeCommit, revision: selection?.revision,
        })
    } catch (error) { rethrowDesktopSharedFileError(error) }
}

function sharedWorkspaceAdmission(runtime: DesktopRuntime, workspaceId: number, signal?: AbortSignal) {
    if (workspaceId !== runtime.workspaceId) throw new DesktopHttpError(409, 'The shared-file workspace changed.')
    const identity = (value: DesktopRuntime) => JSON.stringify([
        value.workspaceId, value.launchNonce, value.dataRoot, value.engineRoot, value.installRoot,
        value.installId, value.buildId, value.app.origin, value.app.sessionToken, value.engine.origin,
    ])
    const expected = identity(runtime)
    return async () => {
        signal?.throwIfAborted()
        const current = await readDesktopRuntime().catch(() => null)
        if (!current || identity(current) !== expected) throw new DesktopHttpError(409, 'The shared-file workspace changed.')
        signal?.throwIfAborted()
        assertDesktopWorkspaceAdmission(runtime)
    }
}

export async function deleteDesktopSharedFile(runtime: DesktopRuntime, workspaceId: number, path: string, revision: string, signal: AbortSignal): Promise<{ path: string }> {
    const beforeCommit = sharedWorkspaceAdmission(runtime, workspaceId, signal)
    try {
        const folderPath = sharedDeleteParentPath(path)
        await beforeCommit()
        const root = await desktopSharedDirectory(runtime, signal)
        return await withSharedDeleteFolder(root, folderPath, { signal, beforeCommit }, (folder, rootPin, guard) =>
            deleteFromPinnedFolder(folder.path, folder.pinned, folder, { ...rootPin, validateEntry: assertSharedDeleteEntry }, path,
                guard, entry => sharedFileRevision(entry) === revision))
    } catch (error) { rethrowDesktopSharedFileError(error) }
}

export async function replaceDesktopSharedText(runtime: DesktopRuntime, workspaceId: number, input: SharedTextReplacement, signal: AbortSignal): Promise<SharedTextReplacementResult> {
    const beforeCommit = sharedWorkspaceAdmission(runtime, workspaceId, signal)
    try {
        await beforeCommit()
        return await replaceSharedText(await desktopSharedDirectory(runtime, signal), input, { signal, beforeCommit })
    } catch (error) { rethrowDesktopSharedFileError(error) }
}
