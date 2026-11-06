import type { TriggerRequestLink, TriggerRequestView } from './types'
export const testTriggerLink: TriggerRequestLink = {
    workspaceId: 'workspace-1', agentId: 'local-agent-1', engineAgentId: 'engine-agent-1', eventId: 'event-1', slug: 'arithmetic',
    sessionId: 'local-chat-1', engineSessionId: 'engine-chat-1', triggerRunId: 'trigger-run-1', sourceRunId: 'trigger-run-1',
    kind: 'question', requestId: 'a'.repeat(64), sourceMessageId: 'message-1', toolCallId: 'call-1', fingerprint: 'source-digest',
}
export const testTriggerView: TriggerRequestView = {
    key: 'b'.repeat(64), link: testTriggerLink, phase: 'pending', continuationId: '00000000-0000-5000-a000-000000000001', acceptedRunId: null,
    runStatus: 'done', availability: 'ready', request: { kind: 'question', value: { id: testTriggerLink.requestId,
        messageId: testTriggerLink.sourceMessageId, toolCallId: testTriggerLink.toolCallId, questions: [{ question: 'What is 6 × 7?', options: ['42'] }] } },
}
