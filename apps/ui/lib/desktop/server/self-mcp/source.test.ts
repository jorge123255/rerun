import { expect, test } from 'vitest'
import type { SelfMcpProposal } from '@rerun/contracts'
import { selfMcpSourceAcknowledged } from './source'
import { selfMcpFingerprint } from './fingerprint'
const input = { name: 'example', transport: 'http' as const, url: 'https://example.com/mcp', args: [], headers: {}, env: {} }
const proposal: SelfMcpProposal = { id: 'proposal', revision: 1, agentId: 'local-owner', identity: { engineAgentId: 'engine-owner', sessionId: 'chat', runId: 'run', toolCallId: 'call-exact' }, launchEpoch: 'old-launch', input, transport: 'http', fingerprint: selfMcpFingerprint(input), configRevision: 0, status: 'pending', createdAt: '2026-11-05T00:00:00Z' }
const result = 'Proposed MCP server "example" (http). A review card is waiting in the Mac app — nothing is saved, connected or executed until a human approves it there.'
function fixture() {
    return {
        tools: [{ agentId: 'engine-owner', sessionId: 'chat', runId: 'run', toolCallId: 'call-exact', toolName: 'mcp_register', inputJson: JSON.stringify(input), resultJson: JSON.stringify(result), isError: 0 }],
        messages: [
            { id: 'assistant', sessionId: 'chat', role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolCallId: 'call-exact', toolName: 'mcp_register', input }]) },
            { id: 'tool', sessionId: 'chat', role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: 'call-exact', toolName: 'mcp_register', output: { type: 'text', value: result } }]) },
        ],
    }
}
test('validates both the exact persisted run invocation and its acknowledged transcript', () => {
    const data = fixture()
    expect(selfMcpSourceAcknowledged(proposal, data, data)).toBe(true)
    expect(selfMcpSourceAcknowledged(proposal, { tools: data.tools }, { messages: [] })).toBe(false)
    expect(selfMcpSourceAcknowledged(proposal, { tools: [...data.tools, ...data.tools] }, data)).toBe(false)
})
test.each(['agentId', 'sessionId', 'runId', 'toolCallId', 'inputJson', 'resultJson'] as const)('refuses changed %s provenance', field => {
    const data = fixture()
    data.tools[0][field] = field === 'inputJson' ? JSON.stringify({ ...input, url: 'https://different.example/mcp' }) : field === 'resultJson' ? JSON.stringify('Nothing was proposed or saved.') : 'foreign'
    expect(selfMcpSourceAcknowledged(proposal, data, data)).toBe(false)
})
test('a tool error or forged transcript acknowledgement cannot make the proposal actionable', () => {
    const data = fixture(); data.tools[0].isError = 1
    expect(selfMcpSourceAcknowledged(proposal, data, data)).toBe(false)
    data.tools[0].isError = 0
    data.messages[1].contentJson = JSON.stringify([{ type: 'tool-result', toolCallId: 'different-call', output: { type: 'text', value: result } }])
    expect(selfMcpSourceAcknowledged(proposal, data, data)).toBe(false)
})
