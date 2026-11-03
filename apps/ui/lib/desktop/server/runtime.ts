import 'server-only'
import { lstat, readFile } from 'node:fs/promises'
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
    workspaceId: z.literal(1),
    dataRoot: z.string().min(1),
    app: z.object({ origin: loopbackOrigin, sessionToken: z.string().min(32) }),
    engine: z.object({ origin: loopbackOrigin, apiKey: z.string().min(1) }),
})

export type DesktopRuntime = z.infer<typeof desktopRuntimeSchema>

export async function readDesktopRuntime(): Promise<DesktopRuntime> {
    if (process.env.RERUN_DESKTOP_APP !== '1') throw new Error('Desktop mode is not enabled')
    const dataDir = process.env.RERUN_DESKTOP_DATA_DIR
    const runtimeFile = process.env.RERUN_DESKTOP_RUNTIME_FILE
    if (!dataDir || !runtimeFile) throw new Error('Desktop runtime paths are not configured')

    const stat = await lstat(runtimeFile)
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('Desktop runtime file must be a regular 0600 file')
    const parsed = desktopRuntimeSchema.parse(JSON.parse(await readFile(runtimeFile, 'utf8')))
    if (resolve(parsed.dataRoot) !== resolve(dataDir)) throw new Error('Desktop runtime data root does not match the assigned directory')
    return parsed
}
