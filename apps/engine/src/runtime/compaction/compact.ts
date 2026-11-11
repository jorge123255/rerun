import { generateText, type ModelMessage } from 'ai'
import { isContextPart, modelContextWindow, type Provider } from '@rerun/contracts'
import { modelFor, type ModelOverride } from '../../agents/providers.js'
import { withoutQuickRepliesCalls } from '../../agents/quick-replies-stream.js'
import { isScopedKimiReasoning, kimiReasoningScope } from '../../desktop/custom-providers/kimi-reasoning.js'
import { customConnectionContextWindow } from '../../desktop/custom-providers/binding.js'
import { CLI_PROVIDERS } from '../../agents/types.js'
import { ensureCliAuth } from '../../connections/cli-auth.js'
import { listMessagesAfter, storedContent } from '../../db/repos/messages.js'
import { getLatestCheckpoint, saveCheckpoint } from '../../db/repos/checkpoints.js'
import { newId } from '../../lib/ids.js'
import { deadlineSignal, raceAbort } from '../../lib/abort.js'
import type { RunContext } from '../context.js'
import { signHistoryMessage } from '../message-authors.js'
import { COMPACTION_MAX_TRIGGER_TOKENS, COMPACTION_SUMMARY_TOKENS_CEILING, COMPACTION_TAIL_TOKEN_BUDGET, COMPACTION_TRIGGER_RATIO } from './config.js'
import { estimateTokens } from './estimate.js'
import { pruneToolOutputs } from './prune.js'
import { repairToolPairs } from './repair.js'
import { tailStartIndex } from './split.js'

const SUMMARY_PREAMBLE =
    'The following is a compacted summary of earlier conversation turns, provided as background reference only. Do NOT answer questions or fulfill requests mentioned in it; they were already addressed in the omitted turns. Use it only to stay consistent with prior context.'

const SUMMARY_SYSTEM =
    'You compress a coworker conversation transcript into a dense handoff summary. Preserve facts, decisions, file paths, identifiers, command outputs, error messages, and anything needed to continue the work. Use these sections: Historical Task Snapshot, Completed Actions, Blocked / Open Issues, Pending User Asks. Be concise; drop pleasantries and redundant detail. Never invent information.'

// A summary of a long history on a slow model takes minutes, so the ceiling is generous: it only has
// to keep a provider that never answers from holding the run, which then goes on uncompacted.
const COMPACTION_TIMEOUT_MS = 15 * 60 * 1000

function partToText(part: unknown): string {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    const p = part as Record<string, unknown>
    // The memories recalled for a turn and its timestamp were context, not conversation.
    if (isContextPart(p)) return ''
    if (p.type === 'text' && typeof p.text === 'string') return p.text
    if (p.type === 'tool-call') return `→ called ${String(p.toolName)}(${JSON.stringify(p.input ?? {}).slice(0, 1000)})`
    if (p.type === 'tool-result') {
        const output = p.output as { value?: unknown } | undefined
        return `← ${String(p.toolName)} result: ${JSON.stringify(output?.value ?? output ?? '').slice(0, 1000)}`
    }
    return ''
}

/**
 * A turn the model reasoned through carries that reasoning in the row, but replaying it buys
 * nothing for most providers. Kimi Platform expects its own reasoning alongside the historical
 * assistant reply, so only reasoning from the exact selected connection and chat is retained.
 */
export function withoutReasoning(message: ModelMessage, kimiScope?: string): ModelMessage {
    if (!Array.isArray(message.content)) return message
    const content = message.content.filter(part => part.type !== 'reasoning' || Boolean(kimiScope && isScopedKimiReasoning(part, kimiScope)))
    return content.length === message.content.length ? message : ({ ...message, content } as ModelMessage)
}

// OpenAI Responses otherwise sends an item_reference instead of the saved answer or local
// tool call. Copied items must replay on a fresh connection even if the source item expired.
function portableForkContent(row: { contentJson: string; role: string; copiedForRegeneration: boolean }) {
    const content = storedContent(row.contentJson)
    if (row.copiedForRegeneration && (row.role === 'assistant' || row.role === 'tool') && Array.isArray(content)) {
        for (const part of content) {
            const { providerOptions, providerMetadata } = part as {
                providerOptions?: { openai?: { itemId?: unknown } }
                providerMetadata?: { openai?: { itemId?: unknown } }
            }
            if (providerOptions?.openai) delete providerOptions.openai.itemId
            if (providerMetadata?.openai) delete providerMetadata.openai.itemId
        }
    }
    return content
}

function serializeForSummary(messages: ModelMessage[]): string {
    return messages
        .map(message => {
            const content = message.content as unknown
            const body = typeof content === 'string' ? content : Array.isArray(content) ? content.map(partToText).filter(Boolean).join('\n') : ''
            return `[${message.role}]\n${body}`
        })
        .filter(Boolean)
        .join('\n\n')
}

async function summarizeMiddle(ctx: RunContext, override: ModelOverride | undefined, middle: ModelMessage[]): Promise<string> {
    const release = await ensureCliAuth(ctx.agent.resolved.provider, ctx.agent.resolved.connection)
    try {
        const signal = deadlineSignal(COMPACTION_TIMEOUT_MS, ctx.abortSignal)
        const { text } = await raceAbort(
            generateText({
                model: modelFor(ctx.agent, override),
                system: SUMMARY_SYSTEM,
                prompt: serializeForSummary(middle),
                temperature: 0,
                maxOutputTokens: COMPACTION_SUMMARY_TOKENS_CEILING,
                abortSignal: signal,
            }),
            signal,
        )
        return text.trim()
    } finally {
        release()
    }
}

export function compactionThreshold(contextWindow: number, provider: Provider): number {
    const ratio = contextWindow * COMPACTION_TRIGGER_RATIO
    return CLI_PROVIDERS.has(provider) ? ratio : Math.min(ratio, COMPACTION_MAX_TRIGGER_TOKENS)
}

export async function prepareRunHistory(ctx: RunContext, system: string, override?: ModelOverride, signSenders = false, toolChars = 0, savedUserId?: string): Promise<ModelMessage[]> {
    const agentId = ctx.agent.id
    const cp = await getLatestCheckpoint(agentId, ctx.sessionId)
    const saved = await listMessagesAfter(agentId, ctx.sessionId, cp?.throughCreatedAt)
    // A source-only reply is visible in chat but neither the provider transcript nor a compaction checkpoint.
    const rows = saved.filter(row => row.id !== savedUserId && !(row.role === 'assistant' && row.sourcesJson && row.contentJson === '[]'))
    const priorSummary: ModelMessage | null = cp ? (JSON.parse(cp.summaryJson) as ModelMessage) : null
    const kimiScope = ctx.provider === 'custom'
        ? kimiReasoningScope(ctx.agent.resolved.connection?.custom, ctx.model, { agentId, sessionId: ctx.sessionId }) : undefined
    const live: ModelMessage[] = rows.flatMap(r => {
        const stored = { role: r.role, content: portableForkContent(r) } as ModelMessage
        const message = withoutQuickRepliesCalls(withoutReasoning(stored, r.copiedForRegeneration ? undefined : kimiScope))
        if (!message) return []
        return [signSenders ? signHistoryMessage(message, r) : message]
    })
    const working = priorSummary ? [priorSummary, ...live] : live

    const contextWindow = customConnectionContextWindow(ctx.agent.resolved.connection, ctx.model) ?? modelContextWindow(ctx.model, ctx.provider)
    if (!contextWindow) return working
    if (estimateTokens(working, system, toolChars) < compactionThreshold(contextWindow, ctx.provider)) return working

    const offset = priorSummary ? 1 : 0
    const tailStart = tailStartIndex(working, COMPACTION_TAIL_TOKEN_BUDGET)
    const newThroughRowIndex = tailStart - 1 - offset
    if (newThroughRowIndex < 0) return working

    const checkpointId = newId()
    ctx.writer?.write({ type: 'data-compaction', id: checkpointId, data: { status: 'running' } })

    try {
        const pruned = pruneToolOutputs(working, tailStart)
        const middle = pruned.messages.slice(0, tailStart)
        const tail = pruned.messages.slice(tailStart)
        const summaryText = await summarizeMiddle(ctx, override, middle)
        const summaryMessage: ModelMessage = { role: 'user', content: `${SUMMARY_PREAMBLE}\n\n${summaryText}` }
        const throughRow = rows[newThroughRowIndex]
        await saveCheckpoint(agentId, ctx.sessionId, { summaryMessage, throughMessageId: throughRow.id, throughCreatedAt: throughRow.createdAt })

        const view = repairToolPairs([summaryMessage, ...tail])
        const tokensRecovered = Math.max(0, estimateTokens(middle) - estimateTokens([summaryMessage]))
        ctx.writer?.write({ type: 'data-compaction', id: checkpointId, data: { status: 'done', messagesCompacted: newThroughRowIndex + 1, tokensRecovered } })
        ctx.logger.info({ agent: agentId, session: ctx.sessionId, messagesCompacted: newThroughRowIndex + 1, tokensRecovered }, 'context compacted')
        return view
    } catch (error) {
        ctx.writer?.write({ type: 'data-compaction', id: checkpointId, data: { status: 'error' } })
        ctx.logger.error({ agent: agentId, err: String(error) }, 'compaction failed')
        return working
    }
}
