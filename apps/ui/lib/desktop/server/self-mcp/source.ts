import 'server-only'
import { selfMcpProposalInput, selfMcpResolvedTransport, stripBridgePrefix, type SelfMcpProposal } from '@rerun/contracts'
import { selfMcpFingerprint } from './fingerprint'
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const json = (value: unknown): unknown => { if (typeof value !== 'string') return value; try { return JSON.parse(value) } catch { return value } }
function candidate(raw: unknown) {
    const { transport, command, url, ...fields } = record(json(raw))
    return selfMcpProposalInput({ ...fields, ...(transport != null ? { transport } : {}), ...(command != null ? { command } : {}), ...(url != null ? { url } : {}) })
}
function text(value: unknown, depth = 0): string | null {
    if (depth > 5) return null
    const parsed = json(value)
    if (typeof parsed === 'string') return parsed
    const part = record(parsed)
    if (part.isError === true || part.type === 'error-text' || part.type === 'error-json') return null
    if ((part.type === 'text' || part.type === 'json') && 'value' in part) return text(part.value, depth + 1)
    if (Array.isArray(part.content) && part.content.length === 1 && record(part.content[0]).type === 'text') return text(record(part.content[0]).text, depth + 1)
    return null
}
export function selfMcpSourceAcknowledged(proposal: SelfMcpProposal, rawTools: unknown, rawMessages: unknown): boolean {
    const tools = record(rawTools).tools, messages = record(rawMessages).messages
    if (!Array.isArray(tools) || !Array.isArray(messages)) return false
    const matching = tools.map(record).filter(tool => tool.toolCallId === proposal.identity.toolCallId)
    if (matching.length !== 1) return false
    const tool = matching[0], input = candidate(tool.inputJson)
    if (tool.agentId !== proposal.identity.engineAgentId || tool.sessionId !== proposal.identity.sessionId || tool.runId !== proposal.identity.runId || tool.isError !== 0
        || typeof tool.toolName !== 'string' || stripBridgePrefix(tool.toolName) !== 'mcp_register' || !input || selfMcpFingerprint(input) !== proposal.fingerprint) return false
    const acknowledgement = text(tool.resultJson)
    const expected = [`Proposed MCP server "${input.name}" (${selfMcpResolvedTransport(input)}). A review card is waiting in the Mac app — nothing is saved, connected or executed until a human approves it there.`, `A proposal for MCP server "${input.name}" from this call is already under review. A review card is waiting in the Mac app.`]
    if (!acknowledgement || !expected.includes(acknowledgement)) return false
    let calls = 0, results = 0
    for (const raw of messages) {
        const row = record(raw)
        if (row.sessionId !== proposal.identity.sessionId) continue
        const content = json(row.contentJson), legacy = json(row.toolCallsJson)
        for (const rawPart of [...(Array.isArray(content) ? content : [content]), ...(Array.isArray(legacy) ? legacy : [])]) {
            const part = record(rawPart), name = part.toolName ?? part.name ?? record(part.function).name
            if ((part.toolCallId ?? part.id) !== proposal.identity.toolCallId) continue
            if (row.role === 'assistant' && (part.type === 'tool-call' || part.type === 'function' || part.function)) {
                const proposed = candidate(part.input ?? part.args ?? part.arguments ?? record(part.function).arguments)
                if (typeof name !== 'string' || stripBridgePrefix(name) !== 'mcp_register' || !proposed || selfMcpFingerprint(proposed) !== proposal.fingerprint) return false
                calls++
            }
            if (row.role === 'tool' || part.type === 'tool-result') {
                if (part.isError === true || text(part.output ?? part.result) !== acknowledgement) return false
                results++
            }
        }
    }
    return calls === 1 && results === 1
}
