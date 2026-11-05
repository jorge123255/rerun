import type { DesktopServiceRequestDetail, DesktopServiceRequestScope } from '@/lib/desktop/service-requests-client'

export const cardRevision = '10000000-0000-4000-8000-000000000001'
export const nextCardRevision = '10000000-0000-4000-8000-000000000002'
export const installationRevision = '20000000-0000-4000-8000-000000000001'
export const mutationRequestId = '30000000-0000-4000-8000-000000000001'
export const scope: DesktopServiceRequestScope = {
    agentId: 'fixture-owner', sessionId: 'fixture-session', serviceRequestId: 'a'.repeat(64),
    source: { sourceMessageId: 'fixture-message', toolCallId: 'fixture-call', fingerprint: '[{"slug":"fixture","reason":"Read the task data."}]' },
}

export function serviceRequestFixture(usable = false): DesktopServiceRequestDetail {
    return {
        serviceRequestId: scope.serviceRequestId, revision: cardRevision, source: { ...scope.source }, currentIndex: 0,
        choices: [{ slug: 'fixture', choice: 'pending' }], retry: { phase: 'open' },
        services: [{ slug: 'fixture', reason: 'Read the task data.',
            catalog: { status: 'available', name: 'Fixture App', category: 'dev', summary: 'Fixture only', icon: null, verified: true,
                connected: false, authentication: 'supported', methods: [{ id: 'key', supported: true }] },
            connectionsStatus: 'ready', connections: usable ? [{ key: 'fixture', slug: 'fixture', revision: installationRevision, state: 'ready', usable: true, healthState: 'healthy' }] : [],
        }],
    }
}

export function finishFixtureResponse(requestId: string) {
    return new Response('data: [DONE]\n\n', { headers: {
        'content-type': 'text/event-stream', 'x-service-request-id': scope.serviceRequestId,
        'x-session-id': scope.sessionId, 'x-run-id': requestId,
    } })
}

export function retryFixtureStorage() {
    const entries = new Map<string, string>()
    return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
}
