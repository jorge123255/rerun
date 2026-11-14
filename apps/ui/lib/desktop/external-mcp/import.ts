import { externalMcpKeyViewSchema, externalMcpRefusalSchema, externalMcpWorkspaceIdSchema } from '@rerun/contracts'
import { z } from 'zod'

/**
 * The outside agents that can reach a Rerun running on this Mac: ones that run on the same Mac.
 * Grok's hosted connector cannot call a loopback address, so it is not offered here.
 */
export const DESKTOP_IMPORT_SOURCES = ['openclaw', 'hermes', 'other'] as const
export type DesktopImportSource = (typeof DESKTOP_IMPORT_SOURCES)[number]

export const desktopImportKeyRequestSchema = z.strictObject({
    requestId: z.uuid(),
    workspaceId: externalMcpWorkspaceIdSchema,
    source: z.enum(DESKTOP_IMPORT_SOURCES),
})
export const desktopImportKeyResultSchema = z.discriminatedUnion('ok', [
    z.strictObject({
        ok: z.literal(true),
        key: externalMcpKeyViewSchema,
        /** The text to hand the outside agent. It carries the key, so it is returned once. */
        prompt: z.string().min(1).max(20_000).nullable(),
    }),
    externalMcpRefusalSchema,
])
export type DesktopImportKeyResult = z.infer<typeof desktopImportKeyResultSchema>
