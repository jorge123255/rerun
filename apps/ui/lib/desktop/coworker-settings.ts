import { verbositySchema, type Verbosity } from '@rerun/contracts'
import { z } from 'zod'

export type DesktopCoworkerSettings = { soul: string; verbosity: Verbosity; soulEditable: boolean }

export const coworkerSettingsPatch = z.strictObject({
    soul: z.string().trim().min(1).optional(),
    verbosity: verbositySchema.optional(),
}).refine(change => change.soul !== undefined || change.verbosity !== undefined)
