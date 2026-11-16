import { z } from 'zod'
import { desktopRerunToolCatalog } from './desktop-tool-grants.js'

// Changes to the team that the Chief of Staff may propose on the Mac. It only proposes: the app
// checks every line against the real workspace, shows the person a card in the app's own words,
// and applies a line only after their click, through the same requests their own clicks make.
// Nothing here is a tool that grants, switches or starts anything by itself.

/** The permissions a proposal may name. Anything that reaches the Mac itself is left to the person. */
export const DESKTOP_TEAM_CHANGE_PERMISSIONS = ['mcp', 'services', 'callAgent', 'githubWrite', 'webSearch', 'webFetch', 'teamRead', 'schedule', 'skills', 'memoryRecall', 'memoryWrite'] as const
export type DesktopTeamChangePermission = (typeof DESKTOP_TEAM_CHANGE_PERMISSIONS)[number]
export const desktopTeamChangePermissionLabel = (id: DesktopTeamChangePermission): string => desktopRerunToolCatalog.find(row => row.id === id)?.label ?? id

export const DESKTOP_TEAM_CHANGE_ACTIONS = ['switch_on', 'switch_off', 'allow', 'stop_allowing', 'give_github', 'start_setup', 'set_model', 'set_effort'] as const
export type DesktopTeamChangeAction = (typeof DESKTOP_TEAM_CHANGE_ACTIONS)[number]
export const DESKTOP_TEAM_CHANGE_LIMITS = { maxChanges: 80, maxSummary: 300 } as const

const short = (max: number) => z.string().trim().min(1).max(max)
/** What the model writes. Names are requests: the app resolves each to a real coworker, permission and model, or refuses the line. */
export const desktopTeamChangesInputSchema = z.strictObject({
    summary: short(DESKTOP_TEAM_CHANGE_LIMITS.maxSummary).describe('One sentence for the person: what these changes are for.'),
    changes: z.array(z.strictObject({
        action: z.enum(DESKTOP_TEAM_CHANGE_ACTIONS),
        coworker: short(120).optional().describe('The coworker\'s exact name. Required for every action except set_effort.'),
        permission: z.enum(DESKTOP_TEAM_CHANGE_PERMISSIONS).optional().describe('For allow and stop_allowing.'),
        connection: short(120).optional().describe('For set_model and set_effort: the name of a connected provider, as listed to you.'),
        model: short(200).optional().describe('For set_model and set_effort: a model that connection offers, as listed to you.'),
        effort: short(32).optional().describe('For set_effort: a reasoning effort that model offers, as listed to you.'),
    })).min(1).max(DESKTOP_TEAM_CHANGE_LIMITS.maxChanges),
})
export type DesktopTeamChangesInput = z.infer<typeof desktopTeamChangesInputSchema>

/** One line as the app accepted it. `label` is written by the app from the resolved names, never by the model. */
export const desktopTeamChangeSchema = z.strictObject({
    key: z.string().regex(/^change-[0-9]{1,3}$/),
    action: z.enum(DESKTOP_TEAM_CHANGE_ACTIONS),
    agentId: z.string().max(200).nullable(),
    coworker: z.string().max(200).nullable(),
    permission: z.enum(DESKTOP_TEAM_CHANGE_PERMISSIONS).nullable(),
    connectionId: z.string().max(256).nullable(),
    model: z.string().max(256).nullable(),
    effort: z.string().max(32).nullable(),
    label: z.string().max(400),
    /** Said under the line when it reaches further than its words suggest. */
    caution: z.string().max(400).nullable(),
    result: z.strictObject({ ok: z.boolean(), message: z.string().max(400).nullable() }).nullable(),
})
export type DesktopTeamChange = z.infer<typeof desktopTeamChangeSchema>

export const desktopTeamChangesSchema = z.strictObject({
    id: z.string().regex(/^ftc_[A-Za-z0-9-]{8,80}$/),
    summary: z.string().max(DESKTOP_TEAM_CHANGE_LIMITS.maxSummary),
    state: z.enum(['shown', 'applied', 'dismissed']),
    changes: z.array(desktopTeamChangeSchema).max(DESKTOP_TEAM_CHANGE_LIMITS.maxChanges),
    createdAt: z.string(),
})
export type DesktopTeamChanges = z.infer<typeof desktopTeamChangesSchema>

export const desktopTeamChangesSettleSchema = z.strictObject({
    id: desktopTeamChangesSchema.shape.id,
    state: z.enum(['applied', 'dismissed']),
    results: z.array(z.strictObject({ key: desktopTeamChangeSchema.shape.key, ok: z.boolean(), message: z.string().max(400).nullable() })).max(DESKTOP_TEAM_CHANGE_LIMITS.maxChanges).default([]),
})

/** What the model may know to choose from: connected providers, their models and each model's efforts. */
export type DesktopTeamModelOption = { connectionId: string; name: string; models: { id: string; efforts: string[] }[] }

export const DESKTOP_TEAM_CHANGES_TOOL = 'propose_team_changes'
export const DESKTOP_TEAM_CHANGES_DESCRIPTION =
    'Propose changes to coworkers that already exist, as a card the person approves with one click: switch a coworker on or off, allow or stop allowing one of its permissions, give it the GitHub sign-in, start its setup, set the model it answers with, or set a model\'s reasoning effort. Nothing changes when you call this: the app checks each line, shows the card in its own words, and applies only what the person approves. Use the coworkers\' exact names. Put every change the person asked for on one card. After calling it, tell them in one sentence that the card is waiting above the message box and end your turn; never say a change was made.'
