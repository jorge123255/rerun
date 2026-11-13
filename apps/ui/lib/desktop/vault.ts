import { z } from 'zod'

const name = z.string().trim().min(1).max(120)
const variable = z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
const value = z.string().min(1).max(16384).refine(secret => secret !== '•••')
const serverName = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,64}$/)
const serverUrl = z.url({ protocol: /^https$/ }).max(2048)
const bearer = z.string().max(8192).regex(/^[!-~]*$/)
const target = { id: z.uuid(), revision: z.uuid() }
const sharing = { agentIds: z.array(z.uuid()).max(250), sharedWithAll: z.boolean() }

export const desktopVaultMutation = z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('create'), name, variable, value }),
    z.strictObject({ operation: z.literal('create-server'), name: serverName, url: serverUrl, bearer }),
    z.strictObject({ operation: z.literal('replace-server-bearer'), ...target, bearer }),
    z.strictObject({ operation: z.literal('replace'), ...target, value }),
    z.strictObject({ operation: z.literal('share'), ...target, ...sharing }),
    z.strictObject({ operation: z.literal('delete'), ...target }),
])

export type DesktopVaultMutation = z.infer<typeof desktopVaultMutation>

const secretEntry = z.strictObject({ ...target, name, variable, ...sharing })
const mcpEntry = z.strictObject({ ...target, name: serverName, kind: z.literal('mcp'), url: serverUrl, hasBearer: z.boolean(), ...sharing })
export const desktopVaultEntry = z.union([secretEntry, mcpEntry])
export const desktopVaultListing = z.strictObject({
    entries: z.array(desktopVaultEntry),
    coworkers: z.array(z.strictObject({ id: z.uuid(), name: z.string() })),
})

export type DesktopVaultListing = z.infer<typeof desktopVaultListing>
export type DesktopVaultEntry = z.infer<typeof desktopVaultEntry>

export const desktopCoworkerVaultMutation = z.strictObject({ ...target, attached: z.boolean() })
export type DesktopCoworkerVaultMutation = z.infer<typeof desktopCoworkerVaultMutation>

const coworkerVaultEntry = z.union([secretEntry.omit({ agentIds: true }), mcpEntry.omit({ agentIds: true })])
export type DesktopCoworkerVaultEntry = z.infer<typeof coworkerVaultEntry>
export const desktopCoworkerVaultListing = z.strictObject({
    agentId: z.uuid(),
    attached: z.array(coworkerVaultEntry),
    available: z.array(coworkerVaultEntry),
})
export type DesktopCoworkerVaultListing = z.infer<typeof desktopCoworkerVaultListing>
