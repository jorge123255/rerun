import { z } from 'zod'

const name = z.string().trim().min(1).max(120)
const variable = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
const value = z.string().min(1).max(16384).refine(secret => secret !== '•••')
const target = { id: z.uuid(), revision: z.uuid() }
const sharing = { agentIds: z.array(z.uuid()).max(250), sharedWithAll: z.boolean() }

export const desktopVaultMutation = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('create'), name, variable, value }),
    z.strictObject({ operation: z.literal('replace'), ...target, value }),
    z.strictObject({ operation: z.literal('share'), ...target, ...sharing }),
    z.strictObject({ operation: z.literal('delete'), ...target }),
])

export type DesktopVaultMutation = z.infer<typeof desktopVaultMutation>

export const desktopVaultEntry = z.strictObject({ ...target, name, variable, ...sharing })
export const desktopVaultListing = z.strictObject({
    entries: z.array(desktopVaultEntry),
    coworkers: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
})

export type DesktopVaultListing = z.infer<typeof desktopVaultListing>
export type DesktopVaultEntry = z.infer<typeof desktopVaultEntry>
