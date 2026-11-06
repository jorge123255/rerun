import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import {
    WHATSAPP_STATUS_DESCRIPTION,
    WHATSAPP_STATUS_OPERATION,
    WHATSAPP_STATUS_TOOL_NAME,
    declaredWhatsappStatusParams,
    whatsappStatusBindingSchema,
    whatsappStatusInputSchema,
    whatsappStatusReceiptSchema,
    whatsappStatusResultSchema,
    whatsappStatusSetupCopy,
    type WhatsappStatusBinding,
    type WhatsappStatusParams,
    type WhatsappStatusResult,
} from './schema.js'

export {
    WHATSAPP_STATUS_DESCRIPTION,
    WHATSAPP_STATUS_OPERATION,
    WHATSAPP_STATUS_TOOL_NAME,
    whatsappStatusSetupCopy,
}

const UNCERTAIN = 'The Status result is unknown. Do not post it again until this attempt is reconciled.'
const CANCELLED = 'Stopped before WhatsApp Status was accepted. Nothing was posted.'

export type WhatsappStatusDispatchRequest = {
    operation: typeof WHATSAPP_STATUS_OPERATION
    accountId: string
    connectionId: string
    params: WhatsappStatusParams
    signal: AbortSignal
}

export type WhatsappStatusDispatchResult =
    | { outcome: 'accepted'; receipt: unknown }
    | { outcome: 'refused'; message: string }
    | { outcome: 'uncertain' }

export type WhatsappStatusPorts = {
    readBinding: (signal: AbortSignal) => Promise<WhatsappStatusBinding>
    dispatch: (request: WhatsappStatusDispatchRequest) => Promise<WhatsappStatusDispatchResult>
}

export const closedWhatsappStatusPorts: WhatsappStatusPorts = {
    async readBinding() {
        return { phase: 'disabled', reason: 'credential-missing' }
    },
    async dispatch() {
        return { outcome: 'uncertain' }
    },
}

function refused(message: string): WhatsappStatusResult {
    return { outcome: 'refused', posted: false, message }
}

function uncertain(): WhatsappStatusResult {
    return { outcome: 'uncertain', posted: false, message: UNCERTAIN }
}

export async function performWhatsappStatus(raw: unknown, ports: WhatsappStatusPorts, signal: AbortSignal): Promise<WhatsappStatusResult> {
    if (signal.aborted) return { outcome: 'cancelled', posted: false, message: CANCELLED }
    const parsed = whatsappStatusInputSchema.safeParse(raw)
    if (!parsed.success) return refused('WhatsApp Status only accepts message, file, phone_numbers, background_color, and font. Nothing was posted.')
    let params: WhatsappStatusParams
    try {
        params = declaredWhatsappStatusParams(parsed.data)
    } catch {
        return refused('Give a text, or an image or video by public URL. Nothing was posted.')
    }
    const binding = whatsappStatusBindingSchema.safeParse(await ports.readBinding(signal))
    if (signal.aborted) return { outcome: 'cancelled', posted: false, message: CANCELLED }
    if (!binding.success) return uncertain()
    if (binding.data.phase !== 'ready') return refused(whatsappStatusSetupCopy[binding.data.reason])
    let dispatched: WhatsappStatusDispatchResult
    try {
        dispatched = await ports.dispatch({
            operation: WHATSAPP_STATUS_OPERATION,
            accountId: binding.data.accountId,
            connectionId: binding.data.connectionId,
            params,
            signal,
        })
    } catch {
        return uncertain()
    }
    if (signal.aborted || dispatched.outcome === 'uncertain') return uncertain()
    if (dispatched.outcome === 'refused') return refused(dispatched.message.trim().slice(0, 400) || 'WhatsApp Status was refused. Nothing was posted.')
    const receipt = whatsappStatusReceiptSchema.safeParse(dispatched.receipt)
    if (!receipt.success) return uncertain()
    return { outcome: 'posted', posted: true, receipt: receipt.data }
}

export function whatsappStatusModelText(result: WhatsappStatusResult): string {
    const parsed = whatsappStatusResultSchema.parse(result)
    if (parsed.outcome !== 'posted') return parsed.message
    return `Posted a WhatsApp Status ${parsed.receipt.statusId}. ${parsed.receipt.audienceCount} people can see it. It expires ${parsed.receipt.expiresAt}.`
}

export async function desktopWhatsappStatusTools(ctx: RunContext, ports: WhatsappStatusPorts = closedWhatsappStatusPorts): Promise<ToolSet> {
    const grants = ctx.agent.config.tools.desktopToolGrants as Record<string, boolean | undefined> | undefined
    if (!ctx.agent.config.enabled || grants?.services !== true || !ctx.abortSignal || !ctx.runId) return {}
    const signal = ctx.abortSignal
    try {
        const binding = whatsappStatusBindingSchema.safeParse(await ports.readBinding(signal))
        if (!binding.success || binding.data.phase !== 'ready') return {}
    } catch {
        return {}
    }
    return {
        [WHATSAPP_STATUS_TOOL_NAME]: tool({
            description: WHATSAPP_STATUS_DESCRIPTION,
            inputSchema: z.object({
                message: z.string().min(1).max(10_000).optional().describe('The text of the Status, or the caption of the image or video'),
                file: z.string().min(1).max(2048).optional().describe('Public URL of one image or video'),
                phone_numbers: z.array(z.string().min(1).max(32)).max(500).optional().describe('Who sees it, in international format. Leave out for the 500 most recent one-to-one chats'),
                background_color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('Background of a text Status, as hex, e.g. #25D366'),
                font: z.number().int().min(0).max(5).optional().describe('Font of a text Status, 0 to 5'),
            }).strict(),
            execute: async input => whatsappStatusModelText(await performWhatsappStatus(input, ports, signal)),
        }),
    }
}

/** The shared Apps compiler must keep refusing managed, Composio, and paid-app methods. */
export function whatsappStatusCompilerGate(slug: string): { slug: 'whatsapp'; operation: typeof WHATSAPP_STATUS_OPERATION; localMcpMethod: false } | null {
    if (slug !== 'whatsapp') return null
    return { slug: 'whatsapp', operation: WHATSAPP_STATUS_OPERATION, localMcpMethod: false }
}
