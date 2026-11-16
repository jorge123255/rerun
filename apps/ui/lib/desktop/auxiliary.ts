import { z } from 'zod'

export const desktopAuxiliaryPurposes = ['search', 'keirolabs-search', 'browser-use-search', 'keenable-search', 'embedding', 'local-embedding', 'transcription', 'elevenlabs-transcription'] as const
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

/** Memory search on this Mac: the saved value is the name of an embedding model in Ollama, never a key. */
export const DESKTOP_LOCAL_EMBEDDING_DEFAULT = 'nomic-embed-text'
export const desktopLocalEmbeddingModel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
export const desktopLocalEmbeddingStatusSchema = z.strictObject({ running: z.boolean(), models: z.array(z.string().max(160)).max(200), embeddingModels: z.array(z.string().max(160)).max(200) })
export type DesktopLocalEmbeddingStatus = z.infer<typeof desktopLocalEmbeddingStatusSchema>
