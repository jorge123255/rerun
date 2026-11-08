import { z } from 'zod'
import type { DesktopOpencodeRefresh, DesktopOpencodeWindow } from '@rerun/contracts'
import type { DesktopOpencodeAuthoritySnapshot } from '../server/opencode/authority'

export type DesktopOpencodeConnectionSnapshot = DesktopOpencodeAuthoritySnapshot
export const desktopOpencodeConnectionSnapshotSchema = z.strictObject({
    workspaceId: z.number().int().positive(),
    owner: z.string().min(1),
    connectionId: z.string().min(1),
    connectionRevision: z.string().min(1),
    apiKey: z.string().nullable(),
    consoleEnabled: z.boolean(),
    enabledModelIds: z.array(z.string()),
    defaultModelId: z.string().min(1),
    state: z.enum(['active', 'deleted', 'disabled', 'replaced']),
    launchNonce: z.string().min(1),
})
export type DesktopOpencodeConnectionScope = { workspaceId: number; connectionId: string }
export type DesktopOpencodeCatalogScope = DesktopOpencodeConnectionScope & { requestId: string; selectedModelId: string }
export type DesktopOpenableEnableInput = DesktopOpencodeConnectionScope & { enabledModelIds: string[]; defaultModelId: string; consoleEnabled: boolean }

export type DesktopOpencodeDriver = {
    snapshot(scope: DesktopOpencodeConnectionScope, signal: AbortSignal): Promise<DesktopOpencodeConnectionSnapshot | null>
    prepare(apiKey: string, signal: AbortSignal): Promise<{ ok: true } | { ok: false; problem: string }>
    catalog(scope: DesktopOpencodeCatalogScope, signal: AbortSignal): Promise<DesktopOpencodeRefresh>
    refresh(scope: DesktopOpencodeCatalogScope, signal: AbortSignal): Promise<DesktopOpencodeRefresh>
    usage(scope: DesktopOpencodeConnectionScope & { requestId: string; refresh?: boolean }, signal: AbortSignal): Promise<{ windows: DesktopOpencodeWindow[]; capturedAt: string | null; fresh: boolean }>
    enable(input: DesktopOpenableEnableInput, signal: AbortSignal): Promise<{ ok: true } | { ok: false; problem: string }>
    disconnect(scope: DesktopOpencodeConnectionScope, signal: AbortSignal): Promise<{ ok: true }>
}

export type DesktopOpencodeSettingsChange =
    | { action: 'key'; provider: 'opencode'; connectionId?: string; apiKey: string; expectedConnectionRevision?: string }
    | { action: 'models'; connectionId: string; models: string[]; extraModels: string[]; expectedConnectionRevision?: string }
    | { action: 'default'; connectionId: string; model: string; expectedConnectionRevision?: string }

export type DesktopOpencodeDefaultPurpose = 'sidebar' | 'chat' | 'foreman' | 'auxiliary'
