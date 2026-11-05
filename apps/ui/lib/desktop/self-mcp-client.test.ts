import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopSelfMcpClient } from './self-mcp-client'

const fetchMock = vi.fn()
afterEach(() => {
    vi.unstubAllGlobals()
})

const proposal = {
    id: 'prop-1',
    revision: 1,
    agentId: 'agent-1',
    identity: { engineAgentId: 'engine-1', sessionId: 's', runId: 'r', toolCallId: 'c' },
    fingerprint: 'a'.repeat(64),
    input: { name: 'linear', transport: 'http', command: undefined, args: [], url: 'https://mcp.linear.app', env: {}, headers: {} },
    transport: 'http',
    configRevision: 3,
    status: 'pending',
    createdAt: '2026-11-05T00:00:00.000Z',
}

describe('createDesktopSelfMcpClient', () => {
    it('lists proposals at the agent management route', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValueOnce(Response.json({ proposals: [proposal] })))
        const client = createDesktopSelfMcpClient('agent-1')
        const result = await client.list()
        expect(result.proposals).toHaveLength(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toContain('/api/desktop/agents/agent-1/self-mcp')
        expect(JSON.parse(String(init?.body))).toMatchObject({ action: 'list' })
        client.dispose()
    })

    it('posts review, decide and dismiss envelopes', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValue(Response.json({})))
        const client = createDesktopSelfMcpClient('agent-1')
        await client.review('prop-1')
        await client.decide({ proposalId: 'prop-1', decisionId: 'dec-1', expectedProposalRevision: 1, expectedConfigRevision: 3, outcome: { kind: 'approved' } })
        await client.dismiss('prop-1', 1)
        const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
        expect(bodies[0]).toMatchObject({ action: 'review', proposalId: 'prop-1' })
        expect(bodies[1]).toMatchObject({ action: 'decide', decision: { decisionId: 'dec-1', outcome: { kind: 'approved' } } })
        expect(bodies[2]).toMatchObject({ action: 'dismiss', proposalId: 'prop-1', expectedProposalRevision: 1 })
        client.dispose()
    })

    it('surfaces server errors and refuses work after dispose', async () => {
        vi.stubGlobal('fetch', fetchMock.mockResolvedValueOnce(Response.json({ error: 'The proposal changed; refresh and review it again.' }, { status: 409 })))
        const client = createDesktopSelfMcpClient('agent-1')
        await expect(client.list()).rejects.toThrow('The proposal changed; refresh and review it again.')
        client.dispose()
        await expect(client.list()).rejects.toThrow('Self-MCP panel owner changed')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
