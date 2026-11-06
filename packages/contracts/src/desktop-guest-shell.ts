import { z } from 'zod'
import { desktopToolInstallGuestIdentitySchema, desktopToolInstallPackageSchema } from './desktop-tool-install.js'

export const DESKTOP_GUEST_SHELL_OUTPUT_MAX_CHARS = 50_000
export const DESKTOP_GUEST_SHELL_COMMAND_MAX_CHARS = 16_000
export const DESKTOP_GUEST_SHELL_TIMEOUT_MAX_MS = 600_000

export const desktopGuestShellInputSchema = z.object({
    command: z.string().min(1).max(DESKTOP_GUEST_SHELL_COMMAND_MAX_CHARS).refine(value => !value.includes('\0'), 'Command contains a null byte.'),
    timeoutMs: z.number().int().positive().max(DESKTOP_GUEST_SHELL_TIMEOUT_MAX_MS).default(120_000),
    cwd: z.string().max(256).default('').refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..'), 'Working directory must stay inside the guest workspace.'),
    packages: z.array(desktopToolInstallPackageSchema).max(8).optional(),
}).strict()
export type DesktopGuestShellInput = z.infer<typeof desktopGuestShellInputSchema>

export const desktopGuestShellIdentitySchema = z.object({
    agentId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    runId: z.string().min(1).max(200),
    toolCallId: z.string().min(1).max(200),
    requestId: z.string().uuid(),
    guest: desktopToolInstallGuestIdentitySchema,
}).strict()
export type DesktopGuestShellIdentity = z.infer<typeof desktopGuestShellIdentitySchema>

export const desktopGuestShellRequestSchema = desktopGuestShellIdentitySchema.extend({
    command: desktopGuestShellInputSchema.shape.command,
    timeoutMs: desktopGuestShellInputSchema.shape.timeoutMs,
    cwd: desktopGuestShellInputSchema.shape.cwd,
    packages: desktopGuestShellInputSchema.shape.packages,
}).strict()
export type DesktopGuestShellRequest = z.infer<typeof desktopGuestShellRequestSchema>

export const desktopGuestShellPackageEvidenceSchema = z.object({
    package: desktopToolInstallPackageSchema,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    lockSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type DesktopGuestShellPackageEvidence = z.infer<typeof desktopGuestShellPackageEvidenceSchema>

export const desktopGuestShellResultSchema = z.object({
    requestId: z.string().uuid(),
    status: z.enum(['done', 'failed', 'timeout', 'cancelled', 'interrupted', 'unavailable']),
    stdout: z.string().max(DESKTOP_GUEST_SHELL_OUTPUT_MAX_CHARS),
    stderr: z.string().max(DESKTOP_GUEST_SHELL_OUTPUT_MAX_CHARS),
    exitCode: z.number().int().min(0).max(255).nullable(),
    durationMs: z.number().int().nonnegative(),
    packageEvidence: z.array(desktopGuestShellPackageEvidenceSchema).max(8).optional(),
    message: z.string().max(1000).optional(),
}).strict()
export type DesktopGuestShellResult = z.infer<typeof desktopGuestShellResultSchema>

export const desktopGuestShellReceiptSchema = desktopGuestShellResultSchema.extend({
    identity: desktopGuestShellIdentitySchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
export type DesktopGuestShellReceipt = z.infer<typeof desktopGuestShellReceiptSchema>
