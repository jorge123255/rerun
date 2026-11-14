import { z } from 'zod'

// Managed apps on the Mac: apps such as Gmail and Outlook that are signed in through the person's
// own Composio account. Composio holds the sign-in to the app; the Mac holds the Composio key.
const slug = z.string().regex(/^[a-z0-9_-]{1,128}$/)
const id = z.string().uuid()

export const desktopManagedAppsViewSchema = z.object({
    configured: z.boolean(),
    // Every app the person's Composio project offers once a key is kept; the bundled ones before that.
    apps: z.array(z.object({ slug, name: z.string().max(200), summary: z.string().max(600) }).strict()).max(5000),
    accounts: z.array(z.object({
        id, slug, name: z.string().max(200), status: z.enum(['pending', 'active']), agentIds: z.array(z.string().max(200)).max(250),
    }).strict()).max(200),
}).strict()
export type DesktopManagedAppsView = z.infer<typeof desktopManagedAppsViewSchema>

export const desktopManagedAppsActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('set-key'), key: z.string().min(8).max(512).regex(/^[!-~]+$/) }).strict(),
    z.object({ action: z.literal('remove-key') }).strict(),
    z.object({ action: z.literal('connect'), slug }).strict(),
    z.object({ action: z.literal('refresh'), id }).strict(),
    z.object({ action: z.literal('remove'), id }).strict(),
    z.object({ action: z.literal('attach'), id, agentId: z.string().min(1).max(200), attached: z.boolean() }).strict(),
])
export type DesktopManagedAppsAction = z.infer<typeof desktopManagedAppsActionSchema>

/** `signIn` is the page to open in the browser after `connect`; it is returned once. */
export const desktopManagedAppsResultSchema = z.object({ view: desktopManagedAppsViewSchema, signIn: z.string().url().optional() }).strict()
export type DesktopManagedAppsResult = z.infer<typeof desktopManagedAppsResultSchema>
