import { z } from 'zod'
import { desktopWorkspaceIdSchema, desktopWorkspaceSwitchPhaseSchema } from './desktop-workspaces.js'

export const DESKTOP_REMOTE_MACHINES_VERSION = 1 as const
export const DESKTOP_REMOTE_MACHINE_LIMITS = {
    addressBytes: 2048, keyBytes: 4096, responseBytes: 131072, requestBytes: 16384,
    requestMs: 10000, operationMs: 60000, cleanupMs: 5000, addresses: 8, receipts: 128,
} as const
export const REMOTE_MACHINE_COPY = {
    title: 'Servers', description: 'The machine your coworkers run on. One per workspace.',
    manualTitle: 'Enter a server by hand', address: 'Address', key: 'API key', connect: 'Connect',
    removeTitle: 'Remove this server?', removeLabel: 'Remove',
    removeDescription: 'Your coworkers stop answering until a server is attached again. Everything they know stays on the machine: attach it again to get them back.',
} as const
export const desktopRemoteActorSchema = z.strictObject({
    installId: z.uuid(), workspaceId: desktopWorkspaceIdSchema,
    launchNonce: z.uuid(), rendererEpoch: z.uuid(),
})
export type DesktopRemoteActor = z.infer<typeof desktopRemoteActorSchema>
export const desktopRemoteIdentitySchema = z.strictObject({
    protocolVersion: z.literal(1), machineId: z.uuid(), workspaceId: desktopWorkspaceIdSchema,
})
export type DesktopRemoteIdentity = z.infer<typeof desktopRemoteIdentitySchema>
export const desktopRemoteIdentityProofSchema = z.strictObject({
    identity: desktopRemoteIdentitySchema, challenge: z.uuid(),
})
export const desktopRemoteHealthSchema = z.strictObject({
    state: z.enum(['not_checked', 'connected', 'unreachable', 'auth_needed', 'identity_changed', 'unsupported', 'cancelled']),
    checkedAt: z.iso.datetime().nullable(), commit: z.string().max(128).nullable(),
    activeAgents: z.number().int().min(0).max(1000000).nullable(), reason: z.string().max(400).nullable(),
})
export type DesktopRemoteHealth = z.infer<typeof desktopRemoteHealthSchema>
export const desktopRemoteConnectionSchema = z.strictObject({
    connectionId: z.uuid(), revision: z.uuid(), workspaceId: desktopWorkspaceIdSchema,
    address: z.string().min(1).max(2048), identity: desktopRemoteIdentitySchema,
    credentialConfigured: z.literal(true), removable: z.literal(true), health: desktopRemoteHealthSchema,
})
export type DesktopRemoteConnection = z.infer<typeof desktopRemoteConnectionSchema>
export const desktopRemoteReceiptSchema = z.strictObject({
    version: z.literal(1), receiptId: z.uuid(), requestId: z.uuid(), installId: z.uuid(),
    workspaceId: desktopWorkspaceIdSchema, kind: z.enum(['pair', 'replace', 'select', 'remove', 'health']),
    connectionId: z.uuid(), configurationRevision: z.uuid(), expectedRevision: z.string().uuid().or(z.literal('unconfigured')),
    revision: z.uuid(), phase: desktopWorkspaceSwitchPhaseSchema,
    effectGeneration: z.number().int().min(0).max(8), closeAttempted: z.boolean(), requiresRecovery: z.boolean(),
    reason: z.string().max(400).nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
})
export type DesktopRemoteReceipt = z.infer<typeof desktopRemoteReceiptSchema>
export const desktopRemoteSnapshotSchema = z.strictObject({
    version: z.literal(1), actor: desktopRemoteActorSchema, revision: z.uuid().or(z.literal('unconfigured')),
    connection: desktopRemoteConnectionSchema.nullable(), selected: z.boolean(),
    runtimeState: z.enum(['connected', 'not_connected', 'unknown']), activeReceipt: desktopRemoteReceiptSchema.nullable(),
    openReceipt: desktopRemoteReceiptSchema.nullable(),
}).refine(s => s.selected ? !!s.connection && !!s.activeReceipt
    && s.activeReceipt.connectionId === s.connection.connectionId && s.activeReceipt.configurationRevision === s.connection.revision
    : s.activeReceipt === null)
export type DesktopRemoteSnapshot = z.infer<typeof desktopRemoteSnapshotSchema>
const command = z.strictObject({ actor: desktopRemoteActorSchema, requestId: z.uuid() })
const exact = { connectionId: z.uuid(), expectedRevision: z.uuid() }
export const desktopRemoteCommandSchema = z.discriminatedUnion('action', [
    command.extend({ action: z.enum(['read', 'reconcile', 'receipt', 'cancel']) }),
    command.extend({ action: z.literal('recover'), resume: z.literal(true), expectedReceiptRevision: z.uuid() }),
    command.extend({ action: z.literal('pair'), connectionId: z.uuid(), expectedRevision: z.literal('unconfigured'), address: z.string().min(1).max(2048), apiKey: z.string().min(16).max(4096).regex(/^[!-~]+$/) }),
    command.extend({ action: z.literal('replace'), ...exact, address: z.string().min(1).max(2048), apiKey: z.string().min(16).max(4096).regex(/^[!-~]+$/) }),
    command.extend({ action: z.enum(['select', 'health']), ...exact }),
    command.extend({ action: z.literal('remove'), ...exact, confirmation: z.literal('Remove') }),
])
export type DesktopRemoteCommand = z.infer<typeof desktopRemoteCommandSchema>
export const desktopRemoteResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), snapshot: desktopRemoteSnapshotSchema, receipt: desktopRemoteReceiptSchema.nullable() }),
    z.strictObject({ ok: z.literal(false), code: z.enum(['invalid', 'stale', 'busy', 'unavailable', 'unsupported', 'auth_needed', 'identity_changed', 'authority_missing', 'uncertain', 'cancelled', 'storage_full']), message: z.string().max(400), authority: z.string().max(120).optional(), receipt: desktopRemoteReceiptSchema.nullable() }),
])
export type DesktopRemoteResult = z.infer<typeof desktopRemoteResultSchema>

/** Main-process-only binding. Credentials and native handles are never public DTOs. */
export type DesktopRemoteEffectContext = {
    installId: string; workspaceId: number; requestId: string; receiptId: string
    effectId: string; kind: DesktopRemoteReceipt['kind']; target: DesktopRemoteIdentity | null
    connectionId: string; configurationRevision: string; selectedBefore: boolean; fromLaunchNonce: string
    effectGeneration: number; recoveryActor?: DesktopRemoteActor
}
export type DesktopRemoteEffectReceipt = {
    effectId: string; requestId: string; workspaceId: number; installId: string
    connectionId: string; configurationRevision: string; applied: true
    value: { saved?: boolean; closed?: boolean; lifetimeId?: string; identity?: DesktopRemoteIdentity }
}
export interface DesktopRemoteLifecyclePorts {
    assertAvailable(effects: string[]): void
    checkActor(actor: DesktopRemoteActor, signal: AbortSignal): Promise<void>
    checkOperation(context: DesktopRemoteEffectContext, signal: AbortSignal): Promise<void>
    lookupEffect(context: DesktopRemoteEffectContext, signal: AbortSignal): Promise<
        { state: 'not_applied' } | { state: 'applied'; receipt: DesktopRemoteEffectReceipt } | { state: 'unknown' }>
    effect(name: 'freeze' | 'flush' | 'drain' | 'close' | 'bind_remote' | 'bind_local' | 'verify' | 'publish' | 'unfreeze',
        context: DesktopRemoteEffectContext, signal: AbortSignal): Promise<DesktopRemoteEffectReceipt>
}
export interface DesktopRemoteMachineBridge {
    execute(command: DesktopRemoteCommand, signal: AbortSignal): Promise<DesktopRemoteResult>
}
