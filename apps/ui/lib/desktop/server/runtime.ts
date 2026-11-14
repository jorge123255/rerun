import 'server-only'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

function isLoopbackOrigin(value: string): boolean {
    try {
        const url = new URL(value)
        return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.pathname === '/' && !url.search && !url.hash
    } catch {
        return false
    }
}

const loopbackOrigin = z.string().refine(isLoopbackOrigin, 'Desktop service origins must use a loopback address')

const desktopRuntimeSchema = z.object({
    protocolVersion: z.literal(1),
    launchNonce: z.string().min(1),
    buildId: z.string().min(1),
    workspaceId: z.number().int().positive(),
    installRoot: z.string().min(1).optional(),
    installId: z.string().uuid().optional(),
    engineRoot: z.string().min(1).optional(),
    dataRoot: z.string().min(1),
    app: z.object({ origin: loopbackOrigin, sessionToken: z.string().min(32) }),
    engine: z.object({ origin: loopbackOrigin, apiKey: z.string().min(1) }),
})

export type DesktopRuntime = z.infer<typeof desktopRuntimeSchema>

export const desktopAppStoreBuild = () => process.env.RERUN_DESKTOP_APP_STORE === '1'

export async function readDesktopRuntime(): Promise<DesktopRuntime> {
    if (process.env.RERUN_DESKTOP_APP !== '1') throw new Error('Desktop mode is not enabled')
    const dataDir = process.env.RERUN_DESKTOP_DATA_DIR
    const runtimeFile = process.env.RERUN_DESKTOP_RUNTIME_FILE
    if (!dataDir || !runtimeFile) throw new Error('Desktop runtime paths are not configured')

    const stat = await lstat(runtimeFile)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('Desktop runtime file must be a regular 0600 file')
    const parsed = desktopRuntimeSchema.parse(JSON.parse(await readFile(runtimeFile, 'utf8')))
    if (resolve(parsed.dataRoot) !== resolve(dataDir)) throw new Error('Desktop runtime data root does not match the assigned directory')
    if (process.env.RERUN_DESKTOP_WORKSPACE_ID && parsed.workspaceId !== Number(process.env.RERUN_DESKTOP_WORKSPACE_ID)) throw new Error('Desktop workspace identity mismatch')
    const installRoot = resolve(process.env.RERUN_DESKTOP_INSTALL_DIR ?? dataDir)
    if (parsed.installRoot && resolve(parsed.installRoot) !== installRoot) throw new Error('Desktop install root changed')
    const expectedData = parsed.workspaceId === 1 ? installRoot : resolve(installRoot, 'workspaces', String(parsed.workspaceId))
    if (resolve(parsed.dataRoot) !== expectedData) throw new Error('Desktop workspace context changed')
    if (parsed.workspaceId !== 1 && !parsed.installId) throw new Error('Desktop installation identity is missing')
    const expectedEngine = resolve(installRoot, 'workspaces', String(parsed.workspaceId), 'engine')
    if (parsed.engineRoot && resolve(parsed.engineRoot) !== expectedEngine || parsed.workspaceId !== 1 && !parsed.engineRoot) throw new Error('Desktop engine storage changed')
    if (parsed.engineRoot) {
        const info = await lstat(parsed.engineRoot)
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || await realpath(parsed.engineRoot) !== parsed.engineRoot) throw new Error('Desktop engine ownership changed')
        const marker = resolve(parsed.engineRoot, 'desktop-owner.json'), ownerInfo = await lstat(marker)
        if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.uid !== process.getuid?.() || ownerInfo.size > 4096) throw new Error('Desktop engine owner is unavailable')
        const owner = z.object({ installId: z.string().uuid(), workspaceId: z.number().int().positive() }).parse(JSON.parse(await readFile(marker, 'utf8')))
        if (owner.workspaceId !== parsed.workspaceId || parsed.installId && owner.installId !== parsed.installId) throw new Error('Desktop engine owner mismatch')
    }
    return parsed
}

/** Per-workspace app databases keep their local row 1; filesystem identity is explicit. */
export function desktopEngineRoot(runtime: DesktopRuntime) {
    return runtime.engineRoot ?? resolve(runtime.dataRoot, 'workspaces', '1', 'engine')
}

/** Canonicalize the assigned context while retaining the no-follow checks below it. */
export async function canonicalDesktopEngineRoot(runtime: DesktopRuntime) {
    return resolve(await realpath(/* turbopackIgnore: true */ runtime.dataRoot), ...desktopEngineParts(runtime))
}

/** Validated relative engine path; existing no-follow readers still pin every component. */
export function desktopEngineParts(runtime: DesktopRuntime): string[] {
    return runtime.workspaceId === 1 ? ['workspaces', '1', 'engine'] : ['engine']
}
