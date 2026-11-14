import { z } from 'zod'

/** The command-line tools the Mac app runs for a signed-in plan, each published by its own vendor. */
export const DESKTOP_CLI_TOOLS = ['claude', 'codex', 'kimi-code', 'grok-build', 'devin'] as const
export const desktopCliToolSchema = z.enum(DESKTOP_CLI_TOOLS)
export type DesktopCliTool = z.infer<typeof desktopCliToolSchema>

const version = z.string().min(1).max(64).regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/)

export const desktopCliToolStatusSchema = z.object({
    tool: desktopCliToolSchema,
    /** The version replies run on now; null when the tool would not say. */
    current: version.nullable(),
    /** Whether that is the copy shipped inside the app or one downloaded from the vendor. */
    source: z.enum(['built-in', 'updated']),
    /** The vendor's newest version, as of `checkedAt`. */
    latest: version.nullable(),
    checkedAt: z.iso.datetime().nullable(),
    /**
     * `waiting`: the new version is downloaded and verified, and takes over once no reply is running.
     * `untested`: the vendor has a newer version but has not tested it with this app's integration.
     */
    state: z.enum(['current', 'available', 'untested', 'downloading', 'waiting', 'failed']),
    /** The version being downloaded or waiting to take over. */
    pending: version.nullable(),
    /** While downloading: the step under way, and for `download` how much has arrived (0 to 1) when the vendor says the size. */
    step: z.enum(['download', 'verify', 'install']).nullable(),
    progress: z.number().min(0).max(1).nullable(),
    error: z.enum(['offline', 'download', 'verification', 'start']).nullable(),
})
export type DesktopCliToolStatus = z.infer<typeof desktopCliToolStatusSchema>

export const desktopCliUpdatesSchema = z.object({ tools: z.array(desktopCliToolStatusSchema).max(DESKTOP_CLI_TOOLS.length) })
export type DesktopCliUpdates = z.infer<typeof desktopCliUpdatesSchema>

export const desktopCliUpdateActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('check') }).strict(),
    z.object({ action: z.literal('update'), tool: desktopCliToolSchema }).strict(),
    /** Go back to the copy shipped inside the app. */
    z.object({ action: z.literal('revert'), tool: desktopCliToolSchema }).strict(),
])
export type DesktopCliUpdateAction = z.infer<typeof desktopCliUpdateActionSchema>
