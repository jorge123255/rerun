import { z } from 'zod'

export const desktopAuxiliaryPurposes = ['search', 'embedding', 'transcription'] as const
export const desktopAuxiliaryPurposeSchema = z.enum(desktopAuxiliaryPurposes)
export type DesktopAuxiliaryPurpose = z.infer<typeof desktopAuxiliaryPurposeSchema>
export const desktopAuxiliaryStatusSchema = z.object({ purpose: desktopAuxiliaryPurposeSchema, revision: z.string(), configured: z.boolean() }).strict()
export const desktopAuxiliarySettingsSchema = z.array(desktopAuxiliaryStatusSchema).length(3)
export type DesktopAuxiliaryStatus = z.infer<typeof desktopAuxiliaryStatusSchema>
export const desktopAuxiliaryChangeSchema = z.object({
    purpose: desktopAuxiliaryPurposeSchema, expectedRevision: z.string().min(1).max(100),
    key: z.string().max(8192).regex(/^[\x21-\x7e]*$/),
}).strict()
