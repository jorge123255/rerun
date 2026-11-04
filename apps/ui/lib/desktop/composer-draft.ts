import { z } from 'zod'
import { isDesktopAttachmentPath } from '@rerun/contracts'

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1)
const fields = { text: z.string().max(20_000), attachmentPath: z.string().max(4096).refine(isDesktopAttachmentPath).optional() }
export const desktopComposerDraftSchema = z.object({ revision, ...fields, updatedAt: z.string().optional() }).strict()
export type DesktopComposerDraft = z.infer<typeof desktopComposerDraftSchema>
export const desktopComposerDraftViewSchema = z.object({ draft: desktopComposerDraftSchema })
export const desktopComposerDraftScopeSchema = z.object({ tabUid: z.string().min(1).max(128) }).strict()
const input = desktopComposerDraftScopeSchema.extend({ requestId: z.string().uuid(), ...fields })
export const desktopComposerDraftWriteSchema = input.extend({ baseRevision: revision }).strict()
export const desktopComposerDraftClearSchema = input.extend({ revision }).strict()
export type DesktopComposerDraftWrite = z.infer<typeof desktopComposerDraftWriteSchema>
export type DesktopComposerDraftClear = z.infer<typeof desktopComposerDraftClearSchema>
