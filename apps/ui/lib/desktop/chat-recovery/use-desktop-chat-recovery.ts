'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DesktopChatRecoveryController, type DesktopRecoveryAction, type DesktopRecoveryNotice, type DesktopRecoveryPorts, type DesktopRecoveryScope } from './controller'

export type DesktopChatRecoveryInput = {
    scope: DesktopRecoveryScope
    error: string | null | undefined
    failedRun: { runId: string | null; error: string | null } | null
    canRetry: boolean
    ports: DesktopRecoveryPorts
    active: boolean
}

export function useDesktopChatRecovery(input: DesktopChatRecoveryInput): { notice: DesktopRecoveryNotice | null; act: (action: DesktopRecoveryAction) => boolean; clear: () => void } {
    const controller = useRef<DesktopChatRecoveryController | null>(null)
    const [revision, setRevision] = useState(0)
    const scopeKey = JSON.stringify([input.scope.agentId, input.scope.tabUid, input.scope.sessionId, input.scope.liveSessionId, input.scope.runId, input.scope.requestId, input.scope.modelRevision])
    const ports = useRef(input.ports)
    ports.current = input.ports
    const canRetry = useRef(input.canRetry)
    canRetry.current = input.canRetry
    const scope = useRef(input.scope)
    scope.current = input.scope
    const failedRun = useRef(input.failedRun)
    failedRun.current = input.failedRun
    const active = useRef(input.active)
    active.current = input.active

    if (!controller.current) {
        controller.current = new DesktopChatRecoveryController(
            {
                retryLastTurn: () => ports.current.retryLastTurn(),
                continueRun: () => ports.current.continueRun(),
                stopRun: () => ports.current.stopRun(),
                newConversation: () => ports.current.newConversation(),
                switchModel: () => ports.current.switchModel(),
                reconnectProvider: () => ports.current.reconnectProvider(),
            },
            () => scope.current,
            () => canRetry.current,
        )
    }

    useEffect(() => {
        if (!input.active) return
        const run = failedRun.current
        if (!input.error && !(run?.runId && run.error)) {
            controller.current?.clear()
        } else {
            controller.current?.observe(input.error)
            if (run?.runId && run.error) controller.current?.observeRunFailure(run.runId, run.error)
        }
        setRevision(n => n + 1)
    }, [input.active, input.error, input.failedRun?.runId, input.failedRun?.error, scopeKey])

    const act = useCallback((action: DesktopRecoveryAction) => {
        if (!active.current) return false
        const handled = controller.current?.act(action) ?? false
        setRevision(n => n + 1)
        return handled
    }, [])

    const clear = useCallback(() => {
        controller.current?.clear()
        setRevision(n => n + 1)
    }, [])

    const notice = useMemo(() => input.active ? controller.current?.view() ?? null : null, [revision, scopeKey, input.error, input.failedRun, input.active])
    return { notice, act, clear }
}
