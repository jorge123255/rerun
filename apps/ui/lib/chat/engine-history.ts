import { desktopToolInstallReferenceOf } from '@/lib/desktop/tool-install-reference'
import { DESKTOP_FOREMAN_DOCS_LIMITS, RERUN_PUBLIC_DOCS_CORPUS, desktopForemanDocsResultSchema, desktopStoredDocumentReferences, type DesktopDocumentReference } from '@rerun/contracts'
import { desktopStoredCoworkerMentions, desktopCoworkerMentionFieldsOf, type DesktopCoworkerMentionFields } from '@rerun/contracts'
import { desktopQuickReplyInputOf } from '@/lib/desktop/quick-replies'
import type { EngineMessage } from '@/lib/engine/types'
import { desktopSummaryMetadata, isDesktopSummaryMetadata } from '@/lib/desktop/reasoning-summary'
import { attachmentDisplayName, parseAttachments } from '@/lib/chat/attachments-marker'
import { parseInstallMessage } from '@/lib/chat/install-marker'
import { parseScheduledRun } from '@/lib/schedules/scheduled-run'
import { encodePeaks } from '@/lib/voice/peaks'
import { parseVoiceMessage } from '@/lib/voice/marker'
import { desktopToolPresentation, type DesktopToolPresentation } from '@/lib/desktop/tool-presentation'
import { DESKTOP_HISTORICAL_PASSTHROUGH_TOOLS } from '@/components/desktop/tool-presentations/plan'
import { redactHistoricalText } from '@/components/desktop/tool-presentations/redact'
import { projectDesktopHistoricalCard } from '@/components/desktop/tool-presentations/select'
import { projectDesktopToolStatus, type DesktopHistoricalToolSource, type DesktopToolPresentationStatus } from '@/components/desktop/tool-presentations/status'
import { desktopTableCardOf } from '@/lib/desktop/table-card'
import { desktopFileCardOf, desktopImageGenerationOutput } from '@/lib/desktop/file-card'
import { desktopSkillProposalIdOf } from '@/lib/desktop/skill-proposal-source'
import { hitlKindOf } from '@/lib/chat-hitl'
import { desktopApprovalInput, desktopQuestionInput, QUICK_REPLIES_TOOL, desktopSourceParts, desktopAttachmentFieldsOf, type DesktopSourcePart, isContextPart, visibleText, desktopStoredAttachmentSelections, desktopImageSnapshotSchema, type DesktopAttachmentFields, billedMicrosOf, isPaidDataTool, stripBridgePrefix, type ConversationAttachment, type ConversationMessage, type ConversationMessageMetadata } from '@rerun/contracts'

type TextPart = { type: 'text'; text: string }
type ToolReceiptState = 'input-streaming' | 'input-available' | 'approval-requested' | 'approval-responded' | 'output-available' | 'output-error' | 'output-denied' | 'cancelled' | 'canceled' | 'unknown'
type ToolInvocationPart = {
    type: `tool-${string}`
    toolCallId: string
    toolName: string
    state: ToolReceiptState
    errorText?: string
    desktopPreview?: true
    preliminary?: boolean
    acknowledgement?: unknown
    ownerId?: unknown
    agentId?: unknown
    workspaceId?: unknown
    runId?: unknown
    restarted?: unknown
    providerMetadata?: unknown
    input: unknown
    output?: unknown
}
type UIMessagePart = { type: 'file'; url: string; mediaType: string; filename: string } | TextPart | ToolInvocationPart | DesktopSourcePart | { type: 'step-start' } | { type: 'reasoning'; text: string; providerMetadata: typeof desktopSummaryMetadata }
export type HistoryMessage = { id: string; role: 'user' | 'assistant'; parts: UIMessagePart[]; metadata?: DesktopAttachmentFields & DesktopCoworkerMentionFields & { authorId?: string; createdAt?: string; documents?: DesktopDocumentReference[] } }

function safeParse(json: string | null | undefined): unknown {
    if (!json) return null
    try {
        return JSON.parse(json)
    } catch {
        return json
    }
}

// A user row holds the words typed and, after them, the context the engine added for the model: the
// memories it recalled and the time of the turn. Only the words are shown.
function extractText(content: unknown): string {
    if (content && typeof content === 'object' && !Array.isArray(content) && typeof (content as { text?: unknown }).text === 'string') {
        return (content as { text: string }).text
    }
    return visibleText(content, '')
}

// rerun-engine persists AI-SDK message content as JSON in `contentJson`
// (and tool calls in `toolCallsJson`). Re-hydrate to UI message parts.
export function transformEngineMessages(messages: EngineMessage[], options?: { desktopSummaries?: boolean; preserveSourceSteps?: boolean }): HistoryMessage[] {
    // Match each result to the nearest preceding call. A provider may reuse a call ID on the
    // next turn or step; an earlier reply must continue showing the file it actually read.
    const pending = new Map<string, unknown>()
    const rowResults = new Map<string, Map<string, unknown>>()
    for (let index = messages.length - 1; index >= 0; index--) {
        const m = messages[index]
        if (m.role === 'user') { pending.clear(); continue }
        const content = safeParse(m.contentJson)
        const parts = Array.isArray(content) ? content : [content]
        for (const part of parts) {
            if (part?.toolCallId && (part.type === 'tool-result' || (m.role === 'tool' && (part.output !== undefined || part.result !== undefined)))) {
                pending.set(part.toolCallId, part.output ?? part.result ?? part)
            }
        }
        if (m.role !== 'assistant' || pending.size === 0) continue
        const legacy = safeParse(m.toolCallsJson)
        const results = new Map<string, unknown>()
        for (const call of [...parts, ...(Array.isArray(legacy) ? legacy : [])]) {
            if (!call || call.type === 'tool-result') continue
            const id = call.toolCallId ?? call.id
            if (pending.has(id)) {
                results.set(id, pending.get(id))
                pending.delete(id)
            }
        }
        if (results.size) rowResults.set(m.id, results)
    }

    const result: HistoryMessage[] = []
    for (const m of messages) {
        if (m.role === 'tool') continue

        const content = safeParse(m.contentJson)

        if (m.role === 'user') {
            const attachment = desktopAttachmentFieldsOf(desktopStoredAttachmentSelections(content))
            const images: UIMessagePart[] = []
            if (Array.isArray(content)) for (const part of content) {
                if (part?.type !== 'file' || typeof part.data !== 'string') continue
                const image = desktopImageSnapshotSchema.safeParse(part.providerOptions?.rerun?.desktopImage)
                if (!image.success || part.mediaType !== image.data.mediaType || part.data.length > 4 * Math.ceil(image.data.byteLength / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) continue
                images.push({ type: 'file', url: `data:${image.data.mediaType};base64,${part.data}`, mediaType: image.data.mediaType, filename: image.data.name })
            }
            result.push({ id: `engine-${m.id}`, role: 'user', parts: [{ type: 'text', text: extractText(content) }, ...images], metadata: { ...(desktopStoredDocumentReferences(content).length && { documents: desktopStoredDocumentReferences(content) }), createdAt: m.createdAt, ...(m.authorId && { authorId: m.authorId }), ...attachment, ...desktopCoworkerMentionFieldsOf(desktopStoredCoworkerMentions(content)) } })
            continue
        }

        // The row holds the turn in the order it was streamed: a text written after a tool call is
        // its own block, after that call, as the live transcript showed it.
        const parts: UIMessagePart[] = []
        const seen = new Set<string>()
        const pushCall = (call: unknown) => {
            const part = toolPartOf(call, rowResults.get(m.id))
            if (seen.has(part.toolCallId)) return
            seen.add(part.toolCallId)
            parts.push(part)
        }
        // A standalone typed part must pass the same desktop filter as a part in an array.
        const contentParts = options?.desktopSummaries && content && typeof content === 'object' && 'type' in content ? [content] : content
        if (Array.isArray(contentParts)) {
            for (const p of contentParts) {
                const t = (p as { type?: string })?.type
                if (t === 'text' && !isContextPart(p)) {
                    const text = String((p as { text?: unknown }).text ?? '')
                    if (text) parts.push({ type: 'text', text })
                } else if (options?.desktopSummaries && m.role === 'assistant' && t === 'reasoning' && !isContextPart(p) &&
                    typeof p.text === 'string' && p.text && isDesktopSummaryMetadata(p.providerOptions)) {
                    parts.push({ type: 'reasoning', text: p.text, providerMetadata: desktopSummaryMetadata })
                } else if (typeof t === 'string' && t.includes('tool') && t !== 'tool-result') {
                    pushCall(p)
                }
            }
        } else {
            const text = extractText(content)
            if (text) parts.push({ type: 'text', text })
        }
        const tcParsed = safeParse(m.toolCallsJson)
        if (Array.isArray(tcParsed)) for (const call of tcParsed) pushCall(call)

        const sources = m.role === 'assistant' && m.sourcesJson ? desktopSourceParts(safeParse(m.sourcesJson)) : []
        parts.push(...sources)

        if (parts.length === 0) continue
        // The message written for a card that went out bare lands in its own row, after the tool
        // row. Live, the AI SDK keeps the whole turn in one message, and both the pinned card and
        // the reply receipt look for the call in the last assistant message: fold it back in.
        const previous = result[result.length - 1]
        if (seen.size === 0 && previous && endsOnHitlCall(previous)) {
            // Source IDs and limits are scoped to a provider step, including inside a folded card.
            if (options?.preserveSourceSteps && sources.length) previous.parts.push({ type: 'step-start' })
            previous.parts.push(...parts)
            continue
        }
        result.push({ id: `engine-${m.id}`, role: 'assistant', parts, metadata: { createdAt: m.createdAt } })
    }

    return result
}

type StoredToolCall = {
    toolCallId?: string
    id?: string
    toolName?: string
    name?: string
    function?: { name?: string }
    input?: unknown
    args?: unknown
    arguments?: unknown
    state?: unknown
    errorText?: unknown
    acknowledgement?: unknown
    preliminary?: unknown
    restarted?: unknown
}

const NONTERMINAL_TOOL_STATES = new Set(['input-streaming', 'input-available', 'output-available'])
const RECORDED_TOOL_STATES = new Set(['approval-requested', 'approval-responded', 'output-error', 'output-denied', 'cancelled', 'canceled'])

function toolPartOf(call: unknown, toolResults?: Map<string, unknown>): ToolInvocationPart {
    const c = call as StoredToolCall
    const toolCallId = c.toolCallId ?? c.id ?? crypto.randomUUID()
    const toolName = c.toolName ?? c.name ?? c.function?.name ?? 'tool'
    const rawInput = c.input ?? c.args ?? c.arguments ?? {}
    const input = typeof rawInput === 'string' ? safeParse(rawInput) : rawInput
    const output = toolResults?.get(toolCallId)
    const recorded = typeof c.state === 'string' && c.state.trim() ? c.state : undefined
    const errorText = typeof c.errorText === 'string' ? c.errorText : undefined
    const receipt = {
        ...(c.acknowledgement !== undefined && { acknowledgement: c.acknowledgement }),
        ...(typeof c.preliminary === 'boolean' && { preliminary: c.preliminary }),
        ...(typeof c.restarted === 'boolean' && { restarted: c.restarted }),
    }
    // A paused ask_user / request_approval has no result yet. Keep that open state so the pinned
    // block re-renders on reload. Cancelled, pending, and malformed states must not become that.
    if (recorded && !NONTERMINAL_TOOL_STATES.has(recorded)) {
        const state = RECORDED_TOOL_STATES.has(recorded) ? recorded as ToolReceiptState : 'unknown'
        return { type: `tool-${toolName}`, toolCallId, toolName, state, input, ...receipt, ...(output !== undefined && { output }), ...(errorText && { errorText }) }
    }
    if (output !== undefined) return { type: `tool-${toolName}`, toolCallId, toolName, state: 'output-available', input, output, ...receipt }
    if (recorded === 'input-streaming' || recorded === 'input-available') {
        return { type: `tool-${toolName}`, toolCallId, toolName, state: recorded, input, ...receipt }
    }
    return { type: `tool-${toolName}`, toolCallId, toolName, state: recorded === 'output-available' ? 'unknown' : 'input-available', input, ...receipt }
}

const PASSTHROUGH_TOOLS = new Set<string>(DESKTOP_HISTORICAL_PASSTHROUGH_TOOLS)

function savedPreview(input: unknown): { preview: string } | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !('preview' in input)) return
    return typeof input.preview === 'string' ? { preview: redactHistoricalText(input.preview) } : undefined
}

function genericReceipt(part: DesktopHistoricalToolSource, view: DesktopToolPresentation, alreadyPublic: boolean): { state: ToolReceiptState; preliminary?: true; input: unknown; output?: string; errorText?: string } {
    let status: DesktopToolPresentationStatus = projectDesktopToolStatus(part)
    if (view.errorText && status !== 'cancelled' && status !== 'unknown' && status !== 'pending') status = 'failed'
    const input = view.input ?? (alreadyPublic ? savedPreview(part.input) : undefined) ?? {}
    if (status === 'pending') return { state: part.state === 'approval-responded' ? 'approval-responded' : 'approval-requested', input }
    if (status === 'running') {
        if (part.state === 'input-streaming') return { state: 'input-streaming', input }
        if (part.preliminary === true) return { state: 'output-available', preliminary: true, input }
        return { state: 'input-available', input }
    }
    if (status === 'failed') return { state: 'output-error', input, ...(view.errorText && { errorText: view.errorText }) }
    if (status === 'cancelled') return { state: part.state === 'canceled' ? 'canceled' : 'cancelled', input }
    if (status === 'unknown') return { state: 'unknown', input }
    const output = view.output ?? (alreadyPublic && typeof part.output === 'string' ? redactHistoricalText(part.output) : undefined)
    return { state: 'output-available', input, ...(output !== undefined && { output }) }
}

function publicForemanDocsResult(output: unknown) {
    let value = output
    // Stored AI SDK results may carry a transport wrapper. Only its value is presentation
    // data; request bindings, headers and any extra fields never cross this boundary.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const wrapper = value as { type?: unknown; value?: unknown }
        if (wrapper.type === 'json' || wrapper.type === 'text') value = wrapper.value
    }
    if (typeof value === 'string') {
        if (value.length > DESKTOP_FOREMAN_DOCS_LIMITS.maxResponseBytes) return null
        try { value = JSON.parse(value) } catch { return null }
    }
    const result = desktopForemanDocsResultSchema.safeParse(value)
    if (!result.success || result.data.documentation !== RERUN_PUBLIC_DOCS_CORPUS.documentation) return null
    if (result.data.source && (result.data.source.corpusId !== RERUN_PUBLIC_DOCS_CORPUS.id || result.data.source.sourceUrl !== RERUN_PUBLIC_DOCS_CORPUS.exportUrl)) return null
    return result.data
}

// Only presentation data leaves the engine-history adapter for a Mac chat. This is after
// HITL folding. The stored ModelMessages and subsequent provider inputs remain untouched.
export function publicDesktopHistory(messages: HistoryMessage[]): HistoryMessage[] {
    return messages.map(message => ({
        ...message,
        parts: message.parts.map(part => {
            if (!('toolName' in part)) return part
            const toolName = stripBridgePrefix(part.toolName)
            if (toolName === QUICK_REPLIES_TOOL) return {
                type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                state: part.state, input: desktopQuickReplyInputOf(part) ?? {},
            }
            if (toolName === 'tool_install') {
                const reference = part.state === 'output-available' ? desktopToolInstallReferenceOf(part.output) : null
                return { type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                    state: part.state, input: {}, ...(reference && reference.toolCallId === part.toolCallId && { output: JSON.stringify(reference) }) }
            }
            if (toolName === 'skill_propose') {
                const proposalId = part.state === 'output-available' ? desktopSkillProposalIdOf(part.output) : null
                return {
                    type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                    state: part.state, input: {},
                    ...(proposalId && { output: JSON.stringify({ status: 'shown', proposalId }) }),
                }
            }
            if (toolName === 'search_docs' && part.state === 'output-available') {
                const result = publicForemanDocsResult(part.output)
                const view = desktopToolPresentation(part.toolName, part.input, undefined)
                return {
                    type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                    state: 'output-available' as const, input: view.input ?? {}, ...(result && { output: JSON.stringify(result) }),
                }
            }
            // A saved file card is itself the public result: keep only its validated path metadata so
            // the tile survives reopening the chat. A malformed card falls through to the normal step.
            if (toolName === 'card_file' && part.state === 'output-available') {
                const card = desktopFileCardOf(part.output)
                if (card) return {
                    type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                    state: 'output-available' as const, input: {}, output: JSON.stringify(card),
                }
            }
            if (toolName === 'image_generation' && part.state === 'output-available') {
                const card = desktopFileCardOf(part.output)
                if (card) return {
                    type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                    state: 'output-available' as const, input: {}, output: JSON.stringify(card),
                }
                return {
                    type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                    state: 'output-available' as const, input: {}, output: desktopImageGenerationOutput(part.output),
                }
            }
            if (toolName === 'card_table' && part.state === 'output-available') {
                const card = desktopTableCardOf(part.output)
                if (card) return {
                    type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                    state: 'output-available' as const, input: {}, output: JSON.stringify(card),
                }
            }
            const historical = projectDesktopHistoricalCard(part)
            if (historical) return {
                type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                state: 'output-available' as const, input: historical.input, output: historical.output,
            }
            if (toolName === 'notify_user') return {
                type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                state: projectDesktopToolStatus(part) === 'failed' ? 'output-error' as const : part.state, input: {},
            }
            const view = desktopToolPresentation(part.toolName, part.input, part.output, typeof part.errorText === 'string' ? part.errorText : undefined)
            const formInput = toolName === 'ask_user' ? desktopQuestionInput(part.input)
                : toolName === 'request_approval' ? desktopApprovalInput(part.input) : null
            if (formInput || PASSTHROUGH_TOOLS.has(toolName)) return {
                type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                state: view.errorText ? 'output-error' as const : part.state, input: formInput ?? view.input ?? {},
                ...(view.output !== undefined && { output: view.output }), ...(view.errorText && { errorText: view.errorText }),
            }
            const receipt = genericReceipt(part, view, part.desktopPreview === true)
            return {
                type: part.type, toolName: part.toolName, toolCallId: part.toolCallId, desktopPreview: true as const,
                state: receipt.state, ...(receipt.preliminary && { preliminary: true }), input: receipt.input,
                ...(receipt.output !== undefined && { output: receipt.output }), ...(receipt.errorText && { errorText: receipt.errorText }),
            }
        }),
    }))
}

function endsOnHitlCall(message: HistoryMessage): boolean {
    const last = message.parts.findLast(part => part.type !== 'source-url' && part.type !== 'source-document' && part.type !== 'step-start')
    return message.role === 'assistant' && !!last && 'toolName' in last && !!hitlKindOf(last.toolName)
}

// The engine has no pagination, so a long research session comes back whole. Past this size a tool
// output is replaced by a preview: the app shows tool outputs collapsed and never needs them entire.
export const MAX_TOOL_OUTPUT_CHARS = 16_000

// Cards are what the app renders as the answer itself, so they always travel whole.
const UNTRIMMED_TOOLS = /(^|__)card_[a-z_]+$/

function trimOutput(toolName: string, output: unknown): unknown {
    if (stripBridgePrefix(toolName) === 'tool_install') return desktopToolInstallReferenceOf(output) ?? output
    if (stripBridgePrefix(toolName) === 'image_generation') return desktopImageGenerationOutput(output)
    if (UNTRIMMED_TOOLS.test(toolName)) return output
    const serialized = typeof output === 'string' ? output : JSON.stringify(output)
    if (serialized === undefined || serialized.length <= MAX_TOOL_OUTPUT_CHARS) return output
    const preview = { truncated: true, preview: serialized.slice(0, MAX_TOOL_OUTPUT_CHARS) }
    // A paid call's receipt adds up what it billed, so the figure outlives the trim.
    if (isPaidDataTool(stripBridgePrefix(toolName))) return { status: (output as { status?: unknown }).status, billedMicros: billedMicrosOf(output), ...preview }
    return preview
}

const MEDIA_TYPES: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    pdf: 'application/pdf',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
}

function attachmentOf(path: string): ConversationAttachment {
    const extension = path.split('.').pop()?.toLowerCase() ?? ''
    return { name: attachmentDisplayName(path), path, mediaType: MEDIA_TYPES[extension] ?? 'application/octet-stream' }
}

// The web parses the voice and attachment markers while rendering. The app gets them already
// lifted into metadata, so no client has to know the marker formats. An install and a scheduled run
// keep their bare guide or prompt as text, for an app older than their metadata.
function userMessageForApi(message: HistoryMessage): ConversationMessage {
    const text = message.parts.map(part => (part.type === 'text' ? part.text : '')).join('')
    const createdAt = message.metadata?.createdAt
    const dated = createdAt ? { createdAt } : {}
    const install = parseInstallMessage(text)
    if (install) return { id: message.id, role: 'user', parts: [{ type: 'text', text: install.guide }], metadata: { ...dated, install: { agentName: install.agentName } } }
    const scheduledRun = parseScheduledRun(text)
    if (scheduledRun) return { id: message.id, role: 'user', parts: [{ type: 'text', text: scheduledRun.prompt }], metadata: { ...dated, scheduledRun: { slug: scheduledRun.slug, name: scheduledRun.name } } }

    const authorId = message.metadata?.authorId
    // A voice message sent with files carries the attachments marker after its voice marker.
    const attachments = parseAttachments(text)
    const voice = parseVoiceMessage(attachments?.text ?? text)
    if (!attachments && !voice) return { id: message.id, role: 'user', parts: message.parts, ...((authorId || createdAt) && { metadata: { ...dated, ...(authorId && { authorId }) } }) }

    const metadata: ConversationMessageMetadata = {
        ...dated,
        ...(authorId && { authorId }),
        ...(attachments && { attachments: attachments.paths.map(attachmentOf) }),
        ...(voice && { voice: { transcript: voice.transcript, src: voice.src, durationMs: voice.durationMs, peaks: encodePeaks(voice.peaks) } }),
    }
    const body = voice ? '' : attachments?.text
    return { id: message.id, role: 'user', parts: body ? [{ type: 'text', text: body }] : [], metadata }
}

export function toApiMessages(messages: HistoryMessage[]): ConversationMessage[] {
    return messages.map(message => {
        if (message.role === 'user') return userMessageForApi(message)
        return {
            id: message.id,
            role: 'assistant',
            parts: message.parts.map(part => {
                if (!('toolName' in part)) return part
                const publicPart = stripBridgePrefix(part.toolName) === 'image_generation' ? { ...part, input: {} } : part
                return 'output' in publicPart && publicPart.output !== undefined
                    ? { ...publicPart, output: trimOutput(publicPart.toolName, publicPart.output) }
                    : publicPart
            }),
            ...(message.metadata?.createdAt && { metadata: { createdAt: message.metadata.createdAt } }),
        }
    })
}
