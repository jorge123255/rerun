import { verbositySchema, type Verbosity } from '@rerun/contracts'
import { z } from 'zod'

export type DesktopCoworkerSettings = {
    soul: string
    verbosity: Verbosity
    soulEditable: boolean
    workspaceReadEnabled: boolean
    suggestedReplies: boolean
    memoryEnabled: boolean
    autoMemory: boolean
    selfImprovementEnabled: boolean
    /** The one GitHub repository this coworker works on, or null. A fact only: no account, no permission. */
    repository: { owner: string; name: string; url: string } | null
}

export const coworkerSettingsPatch = z.strictObject({
    soul: z.string().trim().min(1).optional(),
    verbosity: verbositySchema.optional(),
    workspaceReadEnabled: z.boolean().optional(),
    suggestedReplies: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    autoMemory: z.boolean().optional(),
    /** "owner/name" or a github.com link; null removes it. */
    repository: z.string().trim().max(300).nullable().optional(),
}).refine(change => Object.values(change).some(value => value !== undefined))

export type DesktopCoworkerPatch = z.infer<typeof coworkerSettingsPatch>
