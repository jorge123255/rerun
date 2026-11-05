import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { parseHubOutput, stripBridgePrefix, unwrapToolOutputEnvelope } from '@rerun/contracts'

const MAX_PROPOSAL_RESULT_CHARS = 16_384
const PROPOSAL_ID = /^[A-Za-z0-9_-]{1,128}$/
const record = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const failed = (value: unknown): boolean => {
    const item = record(value)
    return item?.isError === true || item?.type === 'error-text' || item?.type === 'error-json'
}

/** The transcript carries only a source marker; the scoped proposal endpoint supplies its row. */
export function desktopSkillProposalIdOf(output: unknown): string | null {
    if (failed(output)) return null
    const value = unwrapToolOutputEnvelope(output)
    if (failed(value)) return null
    if (typeof value === 'string' && value.length > MAX_PROPOSAL_RESULT_CHARS) return null
    if (Array.isArray(value) && (value.length > 16 || value.some(item => {
        const text = record(item)?.text
        return typeof text === 'string' && text.length > MAX_PROPOSAL_RESULT_CHARS
    }))) return null
    const result = record(parseHubOutput(value))
    const id = result?.proposalId
    return !failed(result) && result?.status === 'shown' && typeof id === 'string' && PROPOSAL_ID.test(id) ? id : null
}

/** Only the tool output that raised a proposal is its source; joined calls create no card. */
export function desktopSkillProposalIds(messages: readonly UIMessage[]): Set<string> {
    const ids = new Set<string>()
    for (const message of messages) if (message.role === 'assistant') for (const part of message.parts) {
        if (!isToolUIPart(part) || stripBridgePrefix(getToolName(part)) !== 'skill_propose' || part.state !== 'output-available') continue
        const id = desktopSkillProposalIdOf(part.output)
        if (id) ids.add(id)
    }
    return ids
}
