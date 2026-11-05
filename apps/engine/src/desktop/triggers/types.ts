import type {
    DesktopTrigger,
    DesktopTriggerChat,
    DesktopTriggerCreate,
    DesktopTriggerDeliveryReceipt,
    DesktopTriggerFireInput,
    DesktopTriggerIngressOrigin,
    DesktopTriggerMethod,
    DesktopTriggerStop,
    DesktopTriggerUpdate,
} from '@rerun/contracts'

export type DesktopTriggerRecord = Omit<DesktopTrigger, 'revision' | 'url' | 'token'> & { token: string }

export type DesktopTriggerOwner = {
    localAgentId: string
    engineAgentId: string
    enabled: boolean
    deleting: boolean
}

export type DesktopTriggerModelOverride = {
    connectionId: string | null
    provider: string | null
    model: string | null
}

export type DesktopTriggerStartResult = {
    runId: string
    sessionId: string
}

export type DesktopTriggerHumanRoute =
    | { kind: 'question'; payload: unknown }
    | { kind: 'approval'; payload: unknown }
    | { kind: 'suggested-app'; payload: unknown }
    | { kind: 'takeover'; payload: unknown }

/**
 * REQUIRED root-injected authority. Missing or no-op implementations must fail closed.
 * Never accept arbitrary paths, owners, model credentials or engine IDs from a renderer/webhook body.
 */
export type DesktopTriggerAuthority = {
    assertActive(): void
    resolveOwnerByEngineId(engineAgentId: string): Promise<DesktopTriggerOwner>
    /** Current exact trigger capability for this coworker. Root promotes the pending catalog grant. */
    assertTriggerGrant(engineAgentId: string): Promise<void>
    /** Existing setup gate — refuse ordinary trigger runs while setup is pending. */
    assertSetupClear(engineAgentId: string): Promise<void>
    resolveAutomationModel(engineAgentId: string, override: DesktopTriggerModelOverride): Promise<DesktopTriggerModelOverride>
    /** Create session source=trigger + startHeadlessRun with real metadata. */
    startTriggerRun(input: {
        engineAgentId: string
        slug: string
        name: string
        message: string
        model: DesktopTriggerModelOverride
        eventId: string
    }): Promise<DesktopTriggerStartResult>
    cancelExactRun(engineAgentId: string, runId: string): Promise<void>
    readRun(engineAgentId: string, runId: string): Promise<{ id: string; sessionId: string; status: string; agentId: string; triggerSource: string | null; triggerSlug: string | null } | null>
    readSession(engineAgentId: string, sessionId: string): Promise<{ id: string; agentId: string; source: string | null; title: string } | null>
    adoptTriggerSession(input: {
        localAgentId: string
        engineAgentId: string
        engineSessionId: string
        runId: string | null
        title: string
    }): Promise<DesktopTriggerChat>
    routeHuman(input: { localAgentId: string; engineAgentId: string; sessionId: string; runId: string | null; route: DesktopTriggerHumanRoute }): Promise<void>
    ingressOrigin(): DesktopTriggerIngressOrigin
    /** Persist/load definitions through trusted engine storage — never from webhook body. */
    listTriggers(engineAgentId: string): Promise<DesktopTriggerRecord[]>
    readTrigger(engineAgentId: string, slug: string): Promise<DesktopTriggerRecord | null>
    writeTrigger(engineAgentId: string, input: {
        name: string
        description: string
        body: string
        methods: DesktopTriggerMethod[]
        enabled: boolean
        connectionId: string | null
        provider: string | null
        model: string | null
        /** When set, preserve this token instead of minting. */
        token?: string
    }): Promise<DesktopTriggerRecord>
    rotateTriggerToken(engineAgentId: string, slug: string, nextToken: string): Promise<DesktopTriggerRecord>
    deleteTrigger(engineAgentId: string, slug: string): Promise<void>
    markFired(engineAgentId: string, slug: string, firedAt: string): Promise<void>
}

export type DesktopTriggerMutationKind = 'create' | 'update' | 'rotate' | 'delete' | 'enable' | 'disable'

export type DesktopTriggerStore = {
    initialize(engineAgentId: string): Promise<void>
    getRevision(engineAgentId: string, slug: string): Promise<string | null>
    bumpRevision(engineAgentId: string, slug: string): Promise<string>
    rememberMutation(input: {
        engineAgentId: string
        requestId: string
        kind: DesktopTriggerMutationKind
        slug: string
        revisionBefore: string | null
        revisionAfter: string | null
        resultJson: string
    }): Promise<void>
    findMutation(engineAgentId: string, requestId: string): Promise<{ kind: DesktopTriggerMutationKind; slug: string; resultJson: string } | null>
    recordEvent(receipt: DesktopTriggerDeliveryReceipt & { payloadPreview: string }): Promise<'created' | 'replay'>
    findEventByFingerprint(engineAgentId: string, slug: string, fingerprint: string): Promise<(DesktopTriggerDeliveryReceipt & { payloadPreview: string }) | null>
    getEvent(engineAgentId: string, eventId: string): Promise<(DesktopTriggerDeliveryReceipt & { payloadPreview: string }) | null>
    updateEvent(engineAgentId: string, eventId: string, patch: Partial<DesktopTriggerDeliveryReceipt>): Promise<void>
    listEvents(engineAgentId: string, slug?: string, limit?: number): Promise<DesktopTriggerDeliveryReceipt[]>
    revokeOwner(engineAgentId: string): Promise<void>
    isRevoked(engineAgentId: string): Promise<boolean>
    recoverUncertain(engineAgentId: string): Promise<void>
}

export type { DesktopTriggerCreate, DesktopTriggerUpdate, DesktopTriggerFireInput, DesktopTriggerStop, DesktopTriggerDeliveryReceipt }
