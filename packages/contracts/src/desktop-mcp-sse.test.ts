import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { desktopMcpSseRequestSchema, desktopMcpSseSnapshotSchema, desktopMcpSseOutcomeSchema } from './desktop-mcp-sse.js'

const ref = { agentId: 'local-owner', serverId: 'immutable-server', name: 'example', expectedRevision: 'revision-1' }
test('SSE control identity is strict and never admits private credential fields', () => {
    const request = { ...ref, requestId: '12345678-1234-4234-8234-123456789abc', operation: 'probe' }
    assert.equal(desktopMcpSseRequestSchema.parse(request).operation, 'probe')
    for (const field of ['headers', 'bearer', 'engineAgentId', 'sessionToken']) assert.equal(desktopMcpSseRequestSchema.safeParse({ ...request, [field]: 'private' }).success, false)
    assert.equal(desktopMcpSseRequestSchema.safeParse({ ...request, expectedRevision: undefined }).success, false)
})
test('SSE public snapshots carry only declared metadata and uncertain calls carry no result', () => {
    assert.equal(desktopMcpSseSnapshotSchema.safeParse({ ...ref, transport: 'sse', endpointDisplay: 'https://example.com', state: 'unchecked', tools: [] }).success, true)
    assert.equal(desktopMcpSseSnapshotSchema.safeParse({ ...ref, transport: 'sse', endpointDisplay: 'https://example.com', state: 'connected', tools: [], credentialGeneration: 'private' }).success, false)
    const requestId = '12345678-1234-4234-8234-123456789abc'
    assert.equal(desktopMcpSseOutcomeSchema.safeParse({ requestId, status: 'uncertain', result: {} }).success, false)
    assert.equal(desktopMcpSseOutcomeSchema.safeParse({ requestId, status: 'completed' }).success, false)
})
