// Saved payload bytes, not normalized presentation objects. These are offline regression fixtures.
export const LEGACY_QUESTION_BYTES = '{"questions":[{"question":"Choose a format","options":["Plain","Rich"],"multiple":false}]}'
export const LEGACY_QUESTION_FINGERPRINT = '[{"question":"Choose a format","options":["Plain","Rich"],"multiple":false}]'
export const LEGACY_SINGULAR_BYTES = '{"question":"Choose a format","suggestions":["Plain","Rich"]}'
export const DESCRIBED_QUESTION_BYTES = '{"v":2,"questions":[{"question":"Choose a format","header":"Format","options":[{"label":"Plain","description":"Easy to edit"},{"label":"Rich","description":"Keep styling"}],"multiple":false}]}'
export const ACCEPTED_LEGACY_ANSWER_BYTES = '{"action":"answer","answers":[["Plain"]]}'
export const interaction = { workspaceId: 1, agentId: 'agent-one', sessionId: 'chat-one', tabUid: 'tab-one', messageId: 'question-message', toolCallId: 'ask-format', sourceFingerprint: LEGACY_QUESTION_FINGERPRINT }
