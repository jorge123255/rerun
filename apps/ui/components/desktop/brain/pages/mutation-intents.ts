import { desktopBrainPageInputSchema, desktopBrainRequestIdSchema, desktopBrainHashSchema, desktopBrainRevisionIdSchema } from '@/lib/desktop/brain-pages'
import { brainSlugSchema } from '@rerun/contracts'
import { z } from 'zod'
import { readBrainUiState, writeBrainUiState } from '@/lib/desktop/brain-ui-state'

const mutationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('save'), slug: brainSlugSchema, input: desktopBrainPageInputSchema }).strict(),
    z.object({ kind: z.literal('delete'), slug: brainSlugSchema, expectedHash: desktopBrainHashSchema }).strict(),
    z.object({ kind: z.literal('revert'), slug: brainSlugSchema, revisionId: desktopBrainRevisionIdSchema, expectedHash: desktopBrainHashSchema }).strict(),
    z.object({ kind: z.literal('confirm'), slug: brainSlugSchema, headings: z.array(z.string()).nullable(), expectedHash: desktopBrainHashSchema }).strict(),
])
export type BrainMutation = z.infer<typeof mutationSchema>
const intentSchema = z.object({ requestId: desktopBrainRequestIdSchema, input: mutationSchema }).strict()
export type BrainMutationIntent = z.infer<typeof intentSchema>
const pendingReservations = new Map<string, Promise<BrainMutationIntent>>()

/** Persist before sending. An unknown response must never turn a retry into a new mutation. */
export function brainMutationIntent(key: string): BrainMutationIntent | null {
    if (typeof window === 'undefined') return null
    const saved = readBrainUiState('intent:' + key)
    if (saved === null) return null
    const parsed = intentSchema.safeParse(saved)
    if (!parsed.success) throw new Error('The saved Brain request could not be read. Your page was left unchanged.')
    return parsed.data
}
export function reserveBrainMutation(key: string, input: BrainMutation): Promise<BrainMutationIntent> {
    const working = pendingReservations.get(key)
    if (working) return working
    const work = reserve(key, input)
    pendingReservations.set(key, work)
    void work.finally(() => { if (pendingReservations.get(key) === work) pendingReservations.delete(key) }).catch(() => {})
    return work
}
async function reserve(key: string, input: BrainMutation): Promise<BrainMutationIntent> {
    const previous = brainMutationIntent(key)
    if (previous) return previous
    const intent = intentSchema.parse({ requestId: crypto.randomUUID(), input })
    await writeBrainUiState('intent:' + key, intent)
    return intent
}
export async function settleBrainMutation(key: string, result: { ok: boolean; uncertain?: boolean }) {
    if (result.ok || !result.uncertain) await writeBrainUiState('intent:' + key, null)
}
