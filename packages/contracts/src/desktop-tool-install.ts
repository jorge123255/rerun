import { z } from 'zod'

export const DESKTOP_TOOL_INSTALL_MAX_PACKAGES = 8
export const DESKTOP_TOOL_INSTALL_OUTPUT_MAX_CHARS = 20_000
export const DESKTOP_TOOL_INSTALL_DEADLINE_MS = 300_000

const publicId = z.string().trim().min(1).max(256)
const hex64 = z.string().regex(/^[a-f0-9]{64}$/)
const packageName = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const desktopToolInstallPackageSchema = z.string().max(300).superRefine((value, context) => {
    const separator = value.lastIndexOf('@')
    const name = separator < 0 ? value : value.slice(0, separator)
    const version = separator < 0 ? '' : value.slice(separator + 1)
    if (!packageName.test(name) || !exactVersion.test(version)) context.addIssue({ code: 'custom', message: `Install refused: ${value} is not an exact npm package@version target.` })
})
export type DesktopToolInstallPackage = z.infer<typeof desktopToolInstallPackageSchema>

export const desktopToolInstallInputSchema = z.strictObject({
    packages: z.array(desktopToolInstallPackageSchema).min(1).max(DESKTOP_TOOL_INSTALL_MAX_PACKAGES).refine(items => new Set(items.map(item => item.slice(0, item.lastIndexOf('@')))).size === items.length, 'Package targets must be unique'),
})
export type DesktopToolInstallInput = z.infer<typeof desktopToolInstallInputSchema>

export const desktopToolInstallGuestIdentitySchema = z.strictObject({
    engineAgentId: publicId,
    launchNonce: publicId,
    sessionGeneration: z.string().regex(/^[a-f0-9]{32}$/),
    workspaceFingerprint: hex64,
})
export type DesktopToolInstallGuestIdentity = z.infer<typeof desktopToolInstallGuestIdentitySchema>

export const desktopToolInstallRunIdentitySchema = z.strictObject({
    agentId: publicId,
    sessionId: publicId,
    runId: publicId,
    toolCallId: publicId,
    proposalRevision: z.string().regex(/^[0-9]{1,18}$/),
    guest: desktopToolInstallGuestIdentitySchema,
})
export type DesktopToolInstallRunIdentity = z.infer<typeof desktopToolInstallRunIdentitySchema>

export const desktopToolInstallPackageOutcomeSchema = z.strictObject({
    package: desktopToolInstallPackageSchema,
    status: z.enum(['pending', 'installing', 'installed', 'failed', 'uncertain']),
    manifestSha256: hex64.optional(),
    lockSha256: hex64.optional(),
    message: z.string().max(1_000).optional(),
})
export type DesktopToolInstallPackageOutcome = z.infer<typeof desktopToolInstallPackageOutcomeSchema>

export const desktopToolInstallSnapshotSchema = z.strictObject({
    operationId: hex64,
    agentId: publicId,
    sessionId: publicId,
    runId: publicId,
    toolCallId: publicId,
    proposalRevision: z.string().regex(/^[0-9]{1,18}$/),
    revision: z.string().regex(/^[0-9]{1,18}$/),
    status: z.enum(['pending-approval', 'approved', 'installing', 'installed', 'partial', 'failed', 'declined', 'cancelled', 'uncertain', 'interrupted']),
    packages: z.array(desktopToolInstallPackageOutcomeSchema).min(1).max(DESKTOP_TOOL_INSTALL_MAX_PACKAGES),
    guestId: hex64,
    availability: z.literal('isolated-guest-only'),
    output: z.string().max(DESKTOP_TOOL_INSTALL_OUTPUT_MAX_CHARS).optional(),
    message: z.string().max(1_000).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
})
export type DesktopToolInstallSnapshot = z.infer<typeof desktopToolInstallSnapshotSchema>

export const desktopToolInstallDecisionSchema = z.strictObject({
    operation: z.literal('decide'),
    requestId: z.string().uuid(),
    operationId: hex64,
    expectedRevision: z.string().regex(/^[0-9]{1,18}$/),
    decision: z.enum(['approved', 'declined']),
    note: z.string().trim().max(20_000).optional(),
})
export type DesktopToolInstallDecision = z.infer<typeof desktopToolInstallDecisionSchema>
export const desktopToolInstallInspectSchema = z.strictObject({
    operation: z.literal('inspect'),
    requestId: z.string().uuid(),
    operationId: hex64,
    expectedRevision: z.string().regex(/^[0-9]{1,18}$/),
})
export type DesktopToolInstallInspect = z.infer<typeof desktopToolInstallInspectSchema>
export const desktopToolInstallActionSchema = z.discriminatedUnion('operation', [desktopToolInstallDecisionSchema, desktopToolInstallInspectSchema])
export type DesktopToolInstallAction = z.infer<typeof desktopToolInstallActionSchema>

export type DesktopToolInstallGuestResult = {
    status: 'installed' | 'partial' | 'failed' | 'cancelled' | 'uncertain'
    packages: DesktopToolInstallPackageOutcome[]
    output?: string
    message?: string
}

export type DesktopToolInstallAuthority = (identity: Omit<DesktopToolInstallRunIdentity, 'guest'>, signal: AbortSignal, phase?: 'propose' | 'review' | 'inspect') => Promise<DesktopToolInstallGuestIdentity>
export type DesktopToolInstallOperation = { identity: DesktopToolInstallRunIdentity; operationId: string; packages: DesktopToolInstallPackage[] }
export type DesktopToolInstallGuestAdapter = {
    execute(operation: DesktopToolInstallOperation, signal: AbortSignal): Promise<DesktopToolInstallGuestResult>
    inspect(operation: DesktopToolInstallOperation, signal: AbortSignal): Promise<DesktopToolInstallGuestResult>
}
export const desktopToolInstallGuestResultSchema = z.strictObject({
    status: z.enum(['installed', 'partial', 'failed', 'cancelled', 'uncertain']),
    packages: z.array(desktopToolInstallPackageOutcomeSchema).min(1).max(DESKTOP_TOOL_INSTALL_MAX_PACKAGES),
    output: z.string().max(DESKTOP_TOOL_INSTALL_OUTPUT_MAX_CHARS).optional(),
    message: z.string().max(1_000).optional(),
})
export type DesktopToolInstallStore = {
    begin(identity: DesktopToolInstallRunIdentity, operationId: string, packages: DesktopToolInstallPackage[]): Promise<'execute' | DesktopToolInstallSnapshot>
    complete(identity: DesktopToolInstallRunIdentity, snapshot: DesktopToolInstallSnapshot): Promise<void>
    reservation(operationId: string): Promise<DesktopToolInstallOperation | null>
    replay(identity: DesktopToolInstallRunIdentity, action: DesktopToolInstallAction): Promise<DesktopToolInstallSnapshot | null>
    claim(identity: DesktopToolInstallRunIdentity, action: DesktopToolInstallAction): Promise<{ claimed: boolean; snapshot: DesktopToolInstallSnapshot }>
    finishRequest(identity: DesktopToolInstallRunIdentity, action: DesktopToolInstallAction, snapshot: DesktopToolInstallSnapshot): Promise<void>
    read(operationId: string): Promise<DesktopToolInstallSnapshot | null>
    list(sessionId: string): Promise<DesktopToolInstallSnapshot[]>
}
export type DesktopToolInstallPorts = {
    authority: DesktopToolInstallAuthority
    guest: DesktopToolInstallGuestAdapter
    outcomes: DesktopToolInstallStore
}

export const desktopToolInstallCapabilityViewSchema = z.strictObject({
    status: z.enum(['ready', 'unconfigured', 'unavailable']),
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
})
export type DesktopToolInstallCapabilityView = z.infer<typeof desktopToolInstallCapabilityViewSchema>

async function digest(value: unknown): Promise<string> {
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function desktopToolInstallGuestId(identity: DesktopToolInstallGuestIdentity): Promise<string> {
    return digest(identity)
}

export function desktopToolInstallOperationId(identity: DesktopToolInstallRunIdentity, packages: DesktopToolInstallPackage[]): Promise<string> {
    return digest([identity, packages])
}

export { createDesktopToolInstallService, type DesktopToolInstallService } from './desktop-tool-install-lifecycle.js'
export * from './desktop-tool-install-projections.js'
