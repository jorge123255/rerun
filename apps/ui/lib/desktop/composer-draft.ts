import { z } from 'zod'
import { desktopAttachmentPathsSchema, isDesktopAttachmentPath } from '@rerun/contracts'

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1)
// A draft keeps the original single path field, and its ordered set when the user picked more
// than one. Both are validated as existing-format workspace paths; file bytes are checked by the
// server when the set changes or the message is sent.
const fields = {
    text: z.string().max(20_000),
    attachmentPath: z.string().max(4096).refine(isDesktopAttachmentPath).optional(),
    attachmentPaths: desktopAttachmentPathsSchema.optional(),
}
const noBothFields = (value: { attachmentPath?: string; attachmentPaths?: string[] }) => !(value.attachmentPath && value.attachmentPaths)
export const desktopComposerDraftSchema = z.object({ revision, ...fields, updatedAt: z.string().optional() }).strict()
    .refine(noBothFields, 'Use one attachment field.')
export type DesktopComposerDraft = z.infer<typeof desktopComposerDraftSchema>
export const desktopComposerDraftViewSchema = z.object({ draft: desktopComposerDraftSchema })
export const desktopComposerDraftScopeSchema = z.object({ tabUid: z.string().min(1).max(128) }).strict()
const input = desktopComposerDraftScopeSchema.extend({ requestId: z.string().uuid(), ...fields })
export const desktopComposerDraftWriteSchema = input.extend({ baseRevision: revision }).strict()
    .refine(noBothFields, 'Use one attachment field.')
export const desktopComposerDraftClearSchema = input.extend({ revision }).strict()
    .refine(noBothFields, 'Use one attachment field.')
export type DesktopComposerDraftWrite = z.infer<typeof desktopComposerDraftWriteSchema>
export type DesktopComposerDraftClear = z.infer<typeof desktopComposerDraftClearSchema>
