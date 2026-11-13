import { z } from 'zod'

// The most recent conversation of each coworker, for the line under its name in the Simple view.
export const desktopCoworkerPreviewsSchema = z.strictObject({
    previews: z.record(z.uuid(), z.strictObject({ title: z.string(), updatedAt: z.string() })),
})
export type DesktopCoworkerPreviews = z.infer<typeof desktopCoworkerPreviewsSchema>
