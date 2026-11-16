import { z } from 'zod'

// What the Mac answers when a chat asks which apps its coworker's tool rows belong to.

/** Only artwork the app ships. A logo is never fetched from the chat. */
const BUNDLED_LOGO = /^\/services\/[\w.-]+\.(?:png|svg|webp|jpg)(?:\?tone=(?:light|dark))?$/
export const desktopBundledLogo = (icon: string | null | undefined) => icon && icon.length <= 200 && BUNDLED_LOGO.test(icon) ? icon : null

const app = {
    slug: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    label: z.string().min(1).max(120).optional(),
    icon: z.string().max(200).nullable(),
    category: z.string().max(64),
}
export const desktopConnectorServerSchema = z.strictObject({ server: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), ...app, custom: z.literal(true).optional() })
export const desktopConnectorToolkitSchema = z.strictObject({ key: z.string().regex(/^[a-z0-9]{1,128}$/), ...app })
export const desktopCoworkerConnectorsSchema = z.strictObject({
    agentId: z.string().min(1).max(200),
    // Apps reached through a named server: its tools are `<server>_<tool>`.
    servers: z.array(desktopConnectorServerSchema).max(200),
    // Apps whose tools carry only a toolkit name ("GMAIL_SEND_EMAIL"), keyed by that name in lower case without punctuation.
    toolkits: z.array(desktopConnectorToolkitSchema).max(600),
})
export type DesktopCoworkerConnectors = z.infer<typeof desktopCoworkerConnectorsSchema>
export type DesktopConnectorApp = z.infer<typeof desktopConnectorServerSchema>
