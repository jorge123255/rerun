import { z } from 'zod'
import { isContextPart, visibleText } from './chat-context.js'
import { hitlKindOf } from './chat-hitl.js'
import { QUICK_REPLIES_TOOL } from './chat-quick-replies.js'
import { stripBridgePrefix } from './chat-tool-name.js'
import { desktopRerunToolCatalog } from './desktop-tool-grants.js'

// Changes to the team that the Chief of Staff may propose on the Mac. It only proposes: the app
// checks every line against the real workspace, shows the person a card in the app's own words,
// and applies a line only after their click, through the same requests their own clicks make.
// Nothing here is a tool that grants, switches or starts anything by itself.

/** The permissions a proposal may name. Anything that reaches the Mac itself is left to the person. */
export const DESKTOP_TEAM_CHANGE_PERMISSIONS = ['mcp', 'services', 'callAgent', 'githubWrite', 'repositoryWorkspace', 'webSearch', 'webFetch', 'teamRead', 'schedule', 'skills', 'memoryRecall', 'memoryWrite'] as const
export type DesktopTeamChangePermission = (typeof DESKTOP_TEAM_CHANGE_PERMISSIONS)[number]
export const desktopTeamChangePermissionLabel = (id: DesktopTeamChangePermission): string => desktopRerunToolCatalog.find(row => row.id === id)?.label ?? id

export const DESKTOP_TEAM_CHANGE_ACTIONS = ['switch_on', 'switch_off', 'allow', 'stop_allowing', 'allow_calls', 'give_github', 'start_setup', 'continue_setup', 'skip_setup', 'reply_setup', 'set_model', 'set_effort'] as const
/** How a proposal names the Chief of Staff itself as the one that may message coworkers. */
export const DESKTOP_TEAM_CHANGE_CHIEF = 'Chief of Staff'
/** In `targets`: every other coworker. */
export const DESKTOP_TEAM_CHANGE_EVERYONE = 'everyone'
export type DesktopTeamChangeAction = (typeof DESKTOP_TEAM_CHANGE_ACTIONS)[number]
export const DESKTOP_TEAM_CHANGE_LIMITS = { maxChanges: 80, maxSummary: 300, maxSetupReply: 1200, maxSetupQuestion: 800, maxSetupMessage: 6000 } as const

const short = (max: number) => z.string().trim().min(1).max(max)
export const desktopInspectCoworkerSetupSchema = z.strictObject({
    coworker: short(120).describe('The exact name of the coworker whose guided setup you want to check.'),
})
/**
 * A finished assistant turn that ended in words to the person can be answered as plain setup
 * text. Real coworkers think and use tools before they reply, so reasoning and tool calls that
 * each have their result are allowed in the same message. Only the visible words are returned:
 * reasoning, tool inputs and tool results never are. A tool still waiting for its result, a
 * person-facing request (question, approval, secret, sign-in, app, browser) or a turn that ended
 * on a tool step is not an ordinary reply.
 */
export function desktopSetupReplyQuestion(row: { role: string; contentJson: string; toolCallsJson?: string | null }): string | null {
    if (row.role !== 'assistant') return null
    try {
        if (row.toolCallsJson != null) {
            // Suggested reply chips are cut from the coworker's own words and never wait for a result.
            const calls: unknown = JSON.parse(row.toolCallsJson)
            if (!Array.isArray(calls) || calls.some(call => typeof call?.toolName !== 'string' || stripBridgePrefix(call.toolName) !== QUICK_REPLIES_TOOL)) return null
        }
        const content: unknown = JSON.parse(row.contentJson)
        if (typeof content === 'string') return content.trim() || null
        if (!Array.isArray(content)) return null
        const calls = new Set<string>()
        const results = new Set<string>()
        let lastStep: 'text' | 'tool' | null = null
        for (const part of content as { type?: unknown; text?: unknown; toolCallId?: unknown; toolName?: unknown }[]) {
            if (part?.type === 'text') {
                if (typeof part.text !== 'string') return null
                if (!isContextPart(part)) lastStep = 'text'
                continue
            }
            if (part?.type === 'reasoning') continue
            if (part?.type !== 'tool-call' && part?.type !== 'tool-result') return null
            if (typeof part.toolCallId !== 'string' || typeof part.toolName !== 'string' || hitlKindOf(part.toolName)) return null
            if (part.type === 'tool-call' && stripBridgePrefix(part.toolName) === QUICK_REPLIES_TOOL) continue
            ;(part.type === 'tool-call' ? calls : results).add(part.toolCallId)
            lastStep = 'tool'
        }
        if (lastStep !== 'text' || calls.size !== results.size || [...calls].some(id => !results.has(id))) return null
        const words = content.filter(part => part?.type === 'text' && !isContextPart(part))
        return visibleText(words, '\n').trim() || null
    } catch { return null }
}

/** The end of a long setup message, where its question usually is, within `max` characters. */
export function desktopSetupQuestionExcerpt(text: string, max: number = DESKTOP_TEAM_CHANGE_LIMITS.maxSetupQuestion): string {
    return text.length <= max ? text : '…' + text.slice(text.length - (max - 1)).trimStart()
}

export const desktopTeamSetupReplySchema = z.strictObject({
    text: short(DESKTOP_TEAM_CHANGE_LIMITS.maxSetupReply),
    sessionId: short(200),
    revision: short(256),
    stepId: short(256),
    question: short(DESKTOP_TEAM_CHANGE_LIMITS.maxSetupQuestion).optional(),
})

/** What the model writes. Names are requests: the app resolves each to a real coworker, permission and model, or refuses the line. */
export const desktopTeamChangesInputSchema = z.strictObject({
    summary: short(DESKTOP_TEAM_CHANGE_LIMITS.maxSummary).describe('One sentence for the person: what these changes are for.'),
    changes: z.array(z.strictObject({
        action: z.enum(DESKTOP_TEAM_CHANGE_ACTIONS),
        coworker: short(120).optional().describe('The coworker\'s exact name. Required for every action except set_effort.'),
        targets: z.array(short(120)).min(1).max(40).optional().describe('For allow_calls: the exact names of the coworkers this one may ask for help, or the single entry "everyone".'),
        permission: z.enum(DESKTOP_TEAM_CHANGE_PERMISSIONS).optional().describe('For allow and stop_allowing.'),
        connection: short(120).optional().describe('For set_model and set_effort: the name of a connected provider, as listed to you.'),
        model: short(200).optional().describe('For set_model and set_effort: a model that connection offers, as listed to you.'),
        reply: short(DESKTOP_TEAM_CHANGE_LIMITS.maxSetupReply).optional().describe('For reply_setup only: the exact, non-sensitive reply the owner will review and may send to this setup chat.'),
        stepId: short(256).optional().describe('For reply_setup only: copy the stepId returned by inspect_coworker_setup for this coworker and this question.'),
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
    /** For skip_setup and continue_setup: the server-observed revision the owner reviewed. */
    setupRevision: short(256).optional(),
    /** A setup skipped before its first turn needs a start; an existing claimed chat resumes. */
    setupResumeAction: z.enum(['start', 'continue']).optional(),
    /** For reply_setup: the setup step and exact text the owner sees before approving. */
    setupReply: desktopTeamSetupReplySchema.optional(),
    /** For allow_calls: who may be asked. Absent on cards kept before this action existed. */
    targetAgentIds: z.array(z.string().max(200)).max(100).nullable().default(null),
    /** For allow_calls: the one that may ask is the Chief of Staff itself, not a coworker. */
    chief: z.boolean().default(false),
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
    'Propose changes to coworkers that already exist, as a card the person approves with one click: switch a coworker on or off, allow or stop allowing one of its permissions, choose which coworkers it may ask for help, give it the GitHub sign-in, start or resume setup, skip a named setup only at the person’s explicit request, send a reviewed reply to its current guided setup step, set the model it answers with, or set a model\'s reasoning effort. Nothing changes when you call this: the app checks each line, shows the card in its own words, and applies only what the person approves. Use the coworkers\' exact names. Put every change the person asked for on one card. After calling it, tell them in one sentence that the card is waiting above the message box and end your turn; never say a change was made.'
