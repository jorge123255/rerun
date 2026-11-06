import type { RunContext } from '../../runtime/context.js'
import { DownloadPermissionError } from './errors.js'

export type DownloadPermission = (ctx: RunContext) => Promise<void>

let bound: DownloadPermission | null = null

/** Root calls this once, after `download` exists on DesktopRerunGrantId. A second bind is refused. */
export function bindDesktopDownloadPermission(check: DownloadPermission): void {
    if (bound) throw new Error('Download permission is already bound.')
    bound = check
}

export function desktopDownloadPermissionBound(): boolean {
    return bound !== null
}

export async function requireBoundDownloadPermission(ctx: RunContext): Promise<void> {
    if (!bound) throw new DownloadPermissionError()
    await bound(ctx)
}
