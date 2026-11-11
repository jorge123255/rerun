import { canonicalDesktopEngineRoot, readDesktopRuntime } from './runtime'
import 'server-only'
import { DesktopHttpError } from './auth'
import type { DesktopRuntime } from './runtime'
import { assertDesktopWorkspaceAdmission } from './workspace-admission'
export { SHARED_IMPORT_BYTES, sharedFileImportLimit } from '../../../../engine/src/desktop/shared-workspace-files'
import {
    importSharedFile,
    importSharedText,
    listSharedDirectory,
    readSharedEditorText,
    renameSharedFile,
    replaceSharedText,
    resolveEngineSharedDirectory,
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
    try { return await listSharedDirectory(await desktopSharedDirectory(runtime, access?.signal), path, access) }
    catch (error) { rethrowDesktopSharedFileError(error) }
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

export async function renameDesktopSharedFile(runtime: DesktopRuntime, path: string, name: string, signal?: AbortSignal): Promise<SharedImportResult> {
    try {
        return await renameSharedFile(await desktopSharedDirectory(runtime, signal), path, name, {
            signal, beforeCommit: () => assertDesktopWorkspaceAdmission(runtime),
        })
    } catch (error) { rethrowDesktopSharedFileError(error) }
}

export async function replaceDesktopSharedText(runtime: DesktopRuntime, workspaceId: number, input: SharedTextReplacement, signal: AbortSignal): Promise<SharedTextReplacementResult> {
    if (workspaceId !== runtime.workspaceId) throw new DesktopHttpError(409, 'The shared-file workspace changed.')
    const identity = (value: DesktopRuntime) => JSON.stringify([
        value.workspaceId, value.launchNonce, value.dataRoot, value.engineRoot, value.installRoot,
        value.installId, value.buildId, value.app.origin, value.app.sessionToken, value.engine.origin,
    ])
    const expected = identity(runtime)
    const beforeCommit = async () => {
        signal.throwIfAborted()
        const current = await readDesktopRuntime().catch(() => null)
        if (!current || identity(current) !== expected) throw new DesktopHttpError(409, 'The shared-file workspace changed.')
        signal.throwIfAborted()
        assertDesktopWorkspaceAdmission(runtime)
    }
    try {
        await beforeCommit()
        return await replaceSharedText(await desktopSharedDirectory(runtime, signal), input, { signal, beforeCommit })
    } catch (error) { rethrowDesktopSharedFileError(error) }
}
