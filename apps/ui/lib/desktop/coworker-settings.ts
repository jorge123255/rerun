import { verbositySchema, type Verbosity } from '@rerun/contracts'
import { z } from 'zod'

export type DesktopCoworkerSettings = {
    soul: string
    verbosity: Verbosity
    soulEditable: boolean
    workspaceReadEnabled: boolean
    memoryEnabled: boolean
    autoMemory: boolean
    selfImprovementEnabled: boolean
}

export const coworkerSettingsPatch = z.strictObject({
    soul: z.string().trim().min(1).optional(),
    verbosity: verbositySchema.optional(),
    workspaceReadEnabled: z.boolean().optional(),
    memoryEnabled: z.boolean().optional(),
    autoMemory: z.boolean().optional(),
}).refine(change => Object.values(change).some(value => value !== undefined))

export type DesktopCoworkerPatch = z.infer<typeof coworkerSettingsPatch>
