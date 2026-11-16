import { z } from 'zod'

export const desktopAuxiliaryPurposes = ['search', 'keirolabs-search', 'keenable-search', 'embedding', 'transcription', 'elevenlabs-transcription'] as const
/** Keenable needs no key: this row only records that the owner turned it on. */
export const DESKTOP_KEYLESS_SEARCH_ON = 'on'
/** Voice notes can be turned into text when either transcription service has a key. */
export function desktopTranscriptionConfigured(rows: readonly { purpose: string; configured: boolean }[]): boolean {
    return rows.some(row => (row.purpose === 'transcription' || row.purpose === 'elevenlabs-transcription') && row.configured)
}
export const desktopAuxiliaryPurposeSchema = z.enum(desktopAuxiliaryPurposes)
export type DesktopAuxiliaryPurpose = z.infer<typeof desktopAuxiliaryPurposeSchema>
export const desktopAuxiliaryStatusSchema = z.object({ purpose: desktopAuxiliaryPurposeSchema, revision: z.string(), configured: z.boolean() }).strict()
export const desktopAuxiliarySettingsSchema = z.array(desktopAuxiliaryStatusSchema).length(desktopAuxiliaryPurposes.length)
export type DesktopAuxiliaryStatus = z.infer<typeof desktopAuxiliaryStatusSchema>
export const desktopAuxiliaryChangeSchema = z.object({
    purpose: desktopAuxiliaryPurposeSchema, expectedRevision: z.string().min(1).max(100),
    key: z.string().max(8192).regex(/^[\x21-\x7e]*$/),
}).strict()
