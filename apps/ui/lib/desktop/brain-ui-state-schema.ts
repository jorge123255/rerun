import { z } from 'zod'

export const BRAIN_UI_VALUE_MAX_BYTES = 1024 * 1024
export const BRAIN_UI_TOTAL_MAX_BYTES = 16 * 1024 * 1024
// Active payloads only. Reserve mutation slots so a full set of drafts can still be saved.
// Cleared revision tombstones are fetched individually and consume neither allowance.
export const BRAIN_UI_MAX_DRAFT_RECORDS = 512
export const BRAIN_UI_MAX_INTENT_RECORDS = 512
export const BRAIN_UI_MAX_RECORDS = BRAIN_UI_MAX_DRAFT_RECORDS + BRAIN_UI_MAX_INTENT_RECORDS
const slug = '[a-z0-9]+(?:-[a-z0-9]+)*'
export const brainUiKeySchema = z.string().max(160).regex(new RegExp(`^(?:draft:${slug}|intent:(?:save|delete|revert|confirm):${slug}|intent:create|new-page|proposal-decision)$`))
export const brainUiValueSchema = z.string().max(BRAIN_UI_VALUE_MAX_BYTES).refine(value => new TextEncoder().encode(value).length <= BRAIN_UI_VALUE_MAX_BYTES).nullable()
export const brainUiRecordSchema = z.object({ key: brainUiKeySchema, revision: z.number().int().nonnegative().safe(), value: brainUiValueSchema }).strict()
export const brainUiWriteSchema = z.object({ key: brainUiKeySchema, baseRevision: z.number().int().nonnegative().safe(), requestId: z.string().uuid(), value: brainUiValueSchema }).strict()
export const brainUiListSchema = z.object({ records: z.array(brainUiRecordSchema).max(BRAIN_UI_MAX_RECORDS) }).strict()
export type BrainUiRecord = z.infer<typeof brainUiRecordSchema>
export type BrainUiWrite = z.infer<typeof brainUiWriteSchema>
