'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
    desktopConnectorApprovalResultSchema, desktopConnectorApprovalViewSchema, toolLabelOf,
    type DesktopConnectorActionKind, type DesktopConnectorApprovalAction, type DesktopConnectorApprovalDecision, type DesktopConnectorApprovalView,
} from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { useDesktopLocale } from '../DesktopLocale'

const KIND = {
    delete: 'boardUI.askDelete', send: 'boardUI.askSend', share: 'boardUI.askShare', post: 'boardUI.askPost', pay: 'boardUI.askPay', credential: 'boardUI.askCredential',
} as const satisfies Record<DesktopConnectorActionKind, string>
const ANSWERS = [
    ['once', 'boardUI.askOnce'], ['conversation', 'boardUI.askConversation'], ['always', 'boardUI.askAlways'], ['deny', 'boardUI.askDeny'],
] as const satisfies readonly (readonly [DesktopConnectorApprovalDecision, string])[]
const EMPTY: DesktopConnectorApprovalView = { pending: [], rules: [] }

/** Sent on this window whenever an answer is given or taken back, so every open list re-reads. */
export const CONNECTOR_APPROVALS_CHANGED = 'rerun:connector-approvals-changed'
export const announceConnectorApprovalsChanged = () => { window.dispatchEvent(new Event(CONNECTOR_APPROVALS_CHANGED)) }

/** What the coworker is told once the person has answered. It is a chat message, so it stays in English like the rest of the run. */
export function connectorAnswerText(tool: string, decision: DesktopConnectorApprovalDecision): string {
    const name = toolLabelOf(tool)
    return decision === 'deny' ? `Declined: ${name}. Do not run it.` : `Allowed: ${name}. Run it now with exactly the same arguments.`
}

/**
 * The connector actions waiting for an answer in this conversation, and the standing answers that
 * reach it. A held action is asked about here; the coworker runs it only after an allow, and is
 * told the answer through `onAnswered`.
 */
export function DesktopConnectorApprovals({ sessionId, generating, disabled, onAnswered }: {
    sessionId: string; generating: boolean; disabled: boolean; onAnswered: (text: string) => void
}) {
    const { t } = useDesktopLocale()
    const [view, setView] = useState<DesktopConnectorApprovalView>(EMPTY)
    const [busy, setBusy] = useState(false)
    const [failed, setFailed] = useState(false)
    const alive = useRef(true)
    const url = `/api/desktop/sessions/${encodeURIComponent(sessionId)}/connector-approvals`
    const read = useCallback(async () => {
        try {
            const response = await fetch(url, { cache: 'no-store' })
            if (!response.ok) return
            const next = desktopConnectorApprovalViewSchema.parse(await response.json())
            if (alive.current) setView(next)
        } catch { /* The next read tries again. */ }
    }, [url])
    useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    // A call can be held at any point of a reply, so the list is read while one is under way and once more when it ends.
    useEffect(() => { setView(EMPTY) }, [url])
    // The coworker's settings can turn a standing answer off while this chat is open.
    useEffect(() => {
        const changed = () => { void read() }
        window.addEventListener(CONNECTOR_APPROVALS_CHANGED, changed)
        return () => window.removeEventListener(CONNECTOR_APPROVALS_CHANGED, changed)
    }, [read])
    useEffect(() => {
        void read()
        if (!generating) return
        const timer = setInterval(() => { void read() }, 3_000)
        return () => clearInterval(timer)
    }, [read, generating])

    async function send(action: DesktopConnectorApprovalAction) {
        setBusy(true); setFailed(false)
        try {
            const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) })
            if (!response.ok) throw new Error('refused')
            if (action.action === 'decide') {
                const result = desktopConnectorApprovalResultSchema.parse(await response.json())
                onAnswered(connectorAnswerText(result.tool, result.decision))
            }
        } catch { if (alive.current) setFailed(true) }
        finally { await read(); if (alive.current) setBusy(false); announceConnectorApprovalsChanged() }
    }

    if (!view.pending.length && !view.rules.length) return null
    const waiting = view.pending[0]
    return (
        <div className="flex w-full flex-col gap-2" data-testid="desktop-connector-approvals">
            {waiting && (
                <section className="rounded-lg border border-border bg-card p-3 text-sm" aria-label={t('boardUI.askTitle', { tool: toolLabelOf(waiting.tool) })}>
                    <p className="font-medium text-foreground">{t('boardUI.askTitle', { tool: toolLabelOf(waiting.tool) })}</p>
                    <p className="mt-0.5 text-muted-foreground">{t(KIND[waiting.kind])}</p>
                    {waiting.preview !== '{}' && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">{waiting.preview}</pre>}
                    <div className="mt-3 flex flex-wrap gap-2">
                        {ANSWERS.map(([decision, label]) => (
                            <Button key={decision} type="button" size="sm" variant={decision === 'once' ? 'default' : decision === 'deny' ? 'ghost' : 'outline'}
                                disabled={busy || disabled || generating} onClick={() => { void send({ action: 'decide', id: waiting.id, decision }) }}>
                                {t(label)}
                            </Button>
                        ))}
                    </div>
                    {failed && <p role="alert" className="mt-2 text-xs text-destructive">{t('boardUI.askFailed')}</p>}
                </section>
            )}
            {view.rules.length > 0 && (
                <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label={t('boardUI.askAllowed')}>
                    <li className="font-medium">{t('boardUI.askAllowed')}</li>
                    {view.rules.map(rule => (
                        <li key={rule.id} className="flex items-center gap-1.5">
                            <span>{t(rule.scope === 'always' ? 'boardUI.askScopeAlways' : 'boardUI.askScopeConversation', { tool: toolLabelOf(rule.tool) })}</span>
                            <button type="button" className="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={busy}
                                onClick={() => { void send({ action: 'forget', ruleId: rule.id }) }}>{t('boardUI.askTurnOff')}</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
