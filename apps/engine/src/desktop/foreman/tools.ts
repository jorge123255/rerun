import { foremanNavigationIntentSchema, foremanShowPlanInputSchema, type DesktopForemanBinding } from '@rerun/contracts'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

// The Foreman's own tools. No tool confirms a plan, builds a team, starts a setup or grants a
// permission: those happen only from the user's explicit click, handled by the app.
export type ForemanToolPorts = {
    // The exact run binding the engine admitted this turn on. Null means no trusted binding.
    binding: DesktopForemanBinding | null
    reportShownPlan(input: { binding: DesktopForemanBinding; toolCallId: string; input: unknown }): Promise<unknown>
    navigate(input: { binding: DesktopForemanBinding; intent: unknown; eventId: string }): Promise<{ ok: boolean; error?: string }>
    discover: ((input: { binding: DesktopForemanBinding; url: string }) => Promise<unknown>) | null
}

export const FOREMAN_FORBIDDEN_TOOL_NAMES = ['confirm_plan', 'build_team', 'approve_plan', 'start_agent_setup', 'grant_tools'] as const

export const SHOW_PLAN_DESCRIPTION =
    'Show the organisation you are proposing as a card, so the user reads it before anything is created: the coworkers you propose, under the divisions they go in. A division left empty for now is still built on the board. They answer by confirming or by asking for changes. A confirmation is taken from there by the app itself: it writes the plan down and builds it, so there is nothing to call after it, and you never confirm on their behalf. Everything on the card is written in English, whatever language the conversation is in.'

export function foremanTools(ports: ForemanToolPorts): ToolSet {
    const binding = ports.binding
    if (!binding) return {}
    const tools: ToolSet = {
        show_plan: tool({
            description: SHOW_PLAN_DESCRIPTION,
            inputSchema: foremanShowPlanInputSchema,
            execute: async (input, options) => ports.reportShownPlan({ binding, toolCallId: options.toolCallId, input }),
        }),
        open_panel: tool({
            description: 'Open a coworker, its setup, or a Box this conversation built, in the window the user is watching. Only works while they are here; it is never replayed later.',
            inputSchema: foremanNavigationIntentSchema,
            execute: async (intent, options) => ports.navigate({ binding, intent, eventId: options.toolCallId }),
        }),
    }
    if (ports.discover) {
        const discover = ports.discover
        tools.read_company = tool({
            description: 'Read the public website of their company to learn what it does. Public pages only, bounded, and every finding names the page it came from. Sources this computer cannot read are reported as unavailable, never guessed.',
            inputSchema: z.strictObject({ url: z.url() }),
            execute: async ({ url }) => discover({ binding, url }),
        })
    }
    return tools
}
