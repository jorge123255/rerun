import { expect, it } from 'vitest'
import { serviceTransportControlSchema, serviceTransportSnapshotSchema } from '@rerun/contracts'
import { ref, requestId } from './regression-harness'
it('rejects client engine identity, headers, executable and inline credentials', () => {
    const request = { ...ref, requestId, action: 'probe' }
    expect(serviceTransportControlSchema.parse(request)).toEqual(request)
    for (const field of ['engineAgentId', 'headers', 'executable', 'bearer', 'url']) expect(serviceTransportControlSchema.safeParse({ ...request, [field]: 'private' }).success).toBe(false)
    expect(serviceTransportSnapshotSchema.safeParse({ ref, transport: 'sse', methodId: 'default', state: 'unchecked', tools: [], observation: 'saved', credentialGeneration: 'private' }).success).toBe(false)
})
