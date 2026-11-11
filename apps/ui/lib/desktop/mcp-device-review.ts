import type { ApprovedDeviceMethod } from './server/mcp-device-custody/model'

export type McpDeviceReviewDecision = {
    reviewId: string
    revision: string
    decisionId: string
    operation: 'approve-device-method' | 'decline-device-method' | 'stop-device-method'
}

/** Scoped renderer response. Codes never enter engine status or tool results. */
export type McpDeviceAuthorization = {
    reviewId: string
    revision: string
    verificationUri: string
    userCode: string
    expiresAt: number
}

/** Human-only projection. Never include this in an engine/model status or continuation. */
export type McpDeviceMethodReview = {
    reviewId: string
    revision: string
    workspaceId: string
    owner: string
    localSessionId: string
    serverName: string
    registrationRevision: string
    method: ApprovedDeviceMethod
    expiresAt: number
    state: 'pending' | 'approved' | 'declined' | 'stopped' | 'revoked' | 'expired'
    receipt?: { decisionId: string; outcome: 'approved' | 'declined'; recordedAt: number }
}
