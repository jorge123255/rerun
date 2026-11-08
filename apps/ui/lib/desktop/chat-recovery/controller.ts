import { classifyChatError, unwrapChatError, type ChatErrorKind } from '@rerun/contracts'

export type DesktopRecoveryScope = {
    agentId: string
    tabUid: string | null
    sessionId: string | null
    liveSessionId: string | null
    runId: string | null
    requestId: string | null
    modelRevision: number
}

export type DesktopRecoveryBinding = {
    scopeKey: string
    generation: number
    modelRevision: number
}

export type DesktopRecoveryNotice = {
    kind: ChatErrorKind
    message: string
    binding: DesktopRecoveryBinding
}

export type DesktopRecoveryAction = 'retry' | 'continue' | 'stop' | 'new-conversation' | 'switch-model' | 'reconnect'

export type DesktopRecoveryPorts = {
    retryLastTurn: () => void | Promise<void>
    continueRun: () => void | Promise<void>
    stopRun: () => void | Promise<void>
    newConversation: () => void
    switchModel: () => void
    reconnectProvider: () => void
}

export const DESKTOP_RECOVERY_RETRY_KINDS: readonly ChatErrorKind[] = ['overloaded', 'generic', 'thinking_replay']

export function desktopRecoveryScopeKey(scope: DesktopRecoveryScope): string {
    return JSON.stringify([scope.agentId, scope.tabUid, scope.sessionId, scope.liveSessionId, scope.runId, scope.requestId])
}

export function classifyDesktopRecovery(raw: string | null | undefined): { kind: ChatErrorKind; message: string } | null {
    const message = unwrapChatError(raw)
    if (!message) return null
    return { kind: classifyChatError(message), message }
}

export class DesktopChatRecoveryController {
    private notice: DesktopRecoveryNotice | null = null
    private generation = 0

    constructor(
        private readonly ports: DesktopRecoveryPorts,
        private readonly currentScope: () => DesktopRecoveryScope,
        private readonly canRetry: () => boolean,
    ) {}

    observe(raw: string | null | undefined, options: { runId?: string | null } = {}): DesktopRecoveryNotice | null {
        const classified = classifyDesktopRecovery(raw)
        if (!classified) return this.notice
        const scope = this.currentScope()
        if (options.runId && scope.runId && options.runId !== scope.runId) return this.view()
        const scopeKey = desktopRecoveryScopeKey(scope)
        if (this.notice && this.notice.binding.scopeKey === scopeKey && this.notice.message === classified.message) return this.view()
        this.generation += 1
        this.notice = { kind: classified.kind, message: classified.message, binding: { scopeKey, generation: this.generation, modelRevision: scope.modelRevision } }
        return this.view()
    }

    observeRunFailure(runId: string | null, error: string | null | undefined): DesktopRecoveryNotice | null {
        if (!runId || !error) return this.view()
        return this.observe(error, { runId })
    }

    clear(): void {
        this.notice = null
    }

    view(): DesktopRecoveryNotice | null {
        if (!this.notice) return null
        return this.notice.binding.scopeKey === desktopRecoveryScopeKey(this.currentScope()) ? this.notice : null
    }

    act(action: DesktopRecoveryAction): boolean {
        const notice = this.view()
        if (!notice) return false
        switch (action) {
            case 'retry':
                if (!DESKTOP_RECOVERY_RETRY_KINDS.includes(notice.kind) || !this.canRetry()) return false
                void this.ports.retryLastTurn()
                return true
            case 'continue':
                if (notice.kind !== 'interrupted') return false
                void this.ports.continueRun()
                return true
            case 'stop':
                if (notice.kind !== 'run_in_flight') return false
                void this.ports.stopRun()
                return true
            case 'new-conversation':
                if (notice.kind !== 'session_gone') return false
                this.ports.newConversation()
                return true
            case 'switch-model':
                if (!['usage_limit', 'provider_error', 'context_window', 'overloaded', 'generic'].includes(notice.kind)) return false
                this.ports.switchModel()
                return true
            case 'reconnect':
                if (notice.kind !== 'unauthorized') return false
                this.ports.reconnectProvider()
                return true
        }
    }
}
