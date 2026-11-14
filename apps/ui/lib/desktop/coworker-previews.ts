import { z } from 'zod'

// The most recent conversation of each coworker, for the line under its name in the Simple view.
// `lastMessage` is absent when the engine could not be read, and null in a conversation without one.
export const desktopCoworkerPreviewsSchema = z.strictObject({
    previews: z.record(z.uuid(), z.strictObject({
        title: z.string(), updatedAt: z.string(),
        lastMessage: z.strictObject({ text: z.string().min(1), mine: z.boolean() }).nullable().optional(),
    })),
})
export type DesktopCoworkerPreviews = z.infer<typeof desktopCoworkerPreviewsSchema>
