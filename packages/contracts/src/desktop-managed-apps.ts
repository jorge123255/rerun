import { z } from 'zod'

// Managed apps on the Mac: apps such as Gmail and Outlook that are signed in through the person's
// own Composio account. Composio holds the sign-in to the app; the Mac holds the Composio key.
const slug = z.string().regex(/^[a-z0-9_-]{1,128}$/)
const id = z.string().uuid()
// What tells two accounts of one app apart ("Work", "Personal"). The first account of an app may have none.
const label = z.string().trim().min(1).max(40).regex(/^[^\u0000-\u001f\u007f]+$/)

export const desktopManagedAppsViewSchema = z.object({
    configured: z.boolean(),
    // Set when the apps are reached through a Composio Connect key kept in the Vault: the name of that Vault entry.
    // Its coworkers are chosen on the entry, so accounts here carry none.
    connector: z.string().max(64).optional(),
    // Every app the person's Composio project offers once a key is kept; the bundled ones before that.
    // `logo` is the app's bundled artwork (a /services/ path) or an https picture from the person's Composio listing.
    apps: z.array(z.object({ slug, name: z.string().max(200), summary: z.string().max(600), logo: z.string().max(700).optional() }).strict()).max(5000),
    accounts: z.array(z.object({
        // `expired`: Composio no longer holds a working sign-in for it; the person signs in again and its coworkers keep it.
        id, slug, name: z.string().max(200), label: label.optional(), status: z.enum(['pending', 'active', 'expired']), agentIds: z.array(z.string().max(200)).max(250),
    }).strict()).max(200),
}).strict()
export type DesktopManagedAppsView = z.infer<typeof desktopManagedAppsViewSchema>

export const desktopManagedAppsActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('set-key'), key: z.string().min(8).max(512).regex(/^[!-~]+$/) }).strict(),
    z.object({ action: z.literal('remove-key') }).strict(),
    z.object({ action: z.literal('connect'), slug, label: label.optional() }).strict(),
    z.object({ action: z.literal('refresh'), id, retry: z.boolean().optional() }).strict(),
    z.object({ action: z.literal('remove'), id }).strict(),
    // With a Connect key: looks for apps already signed in at Composio and lists them.
    z.object({ action: z.literal('find') }).strict(),
    z.object({ action: z.literal('attach'), id, agentId: z.string().min(1).max(200), attached: z.boolean() }).strict(),
])
export type DesktopManagedAppsAction = z.infer<typeof desktopManagedAppsActionSchema>

/** `signIn` is the page to open in the browser after `connect`; it is returned once. */
// `addedToVault` names the Vault entry made for a Composio Connect key: that key opens one connector for every app,
// so it is kept as a Vault MCP server rather than as a managed-apps key.
export const desktopManagedAppsResultSchema = z.object({ view: desktopManagedAppsViewSchema, signIn: z.string().url().optional(), addedToVault: z.string().max(64).optional() }).strict()
export type DesktopManagedAppsResult = z.infer<typeof desktopManagedAppsResultSchema>
