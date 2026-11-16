'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
    DESKTOP_BROWSER_PRESS_TOOL, desktopConnectorApprovalResultSchema, desktopConnectorApprovalViewSchema, desktopConnectorPreviewSchema, toolLabelOf,
    type DesktopApprovalKind, type DesktopConnectorPreview, type DesktopConnectorApprovalAction, type DesktopConnectorApprovalDecision, type DesktopConnectorApprovalView,
} from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { useDesktopLocale } from '../DesktopLocale'

const KIND = {
    delete: 'boardUI.askDelete', send: 'boardUI.askSend', share: 'boardUI.askShare', post: 'boardUI.askPost', pay: 'boardUI.askPay', credential: 'boardUI.askCredential', press: 'boardUI.askPressAny',
} as const satisfies Record<DesktopApprovalKind, string>
const ANSWERS = [
    ['once', 'boardUI.askOnce'], ['conversation', 'boardUI.askConversation'], ['always', 'boardUI.askAlways'], ['deny', 'boardUI.askDeny'],
] as const satisfies readonly (readonly [DesktopConnectorApprovalDecision, string])[]
const EMPTY: DesktopConnectorApprovalView = { pending: [], rules: [] }

/** Sent on this window whenever an answer is given or taken back, so every open list re-reads. */
export const CONNECTOR_APPROVALS_CHANGED = 'rerun:connector-approvals-changed'
export const announceConnectorApprovalsChanged = () => { window.dispatchEvent(new Event(CONNECTOR_APPROVALS_CHANGED)) }

/** What the coworker is told once the person has answered. It is a chat message, so it stays in English like the rest of the run. */
// It is also what the person reads as their own message, so it is said in their voice. A decline tells the
// coworker not to look for another way round (the wording follows CopilotKit/OpenBot's approval outcomes, MIT).
// A browser press is never named by its label here: the label is page content, and this is a message from the person.
export function connectorAnswerText(tool: string, decision: DesktopConnectorApprovalDecision): string {
    const press = tool === DESKTOP_BROWSER_PRESS_TOOL
    const name = press ? 'the press in the browser you asked about' : toolLabelOf(tool)
    if (decision === 'deny') return `Declined: ${name}. I decided not to have this done. Do not do it, or anything equivalent, another way; tell me briefly what you did not do.`
    return press ? `Allowed once: ${name}. Make exactly the same press now. It covers that one press only.` : `Allowed: ${name}. Run it now with exactly the same arguments.`
}

const HEADERS = [
    [/^(?:recipient_?emails?|to|recipients?|to_?emails?)$/i, 'boardUI.askTo'], [/^cc$/i, 'boardUI.askCc'], [/^bcc$/i, 'boardUI.askBcc'], [/^(?:subject|title)$/i, 'boardUI.askSubject'],
] as const
const BODY = /^(?:body|message|text|content|html_?body)$/i
const words = (key: string) => { const text = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase(); return text.charAt(0).toUpperCase() + text.slice(1) }
// A list arrives as JSON text: ["a","b"] reads better as a, b.
const plain = (value: string) => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed.join(', ') : value } catch { return value } }

function readPreview(preview: string): DesktopConnectorPreview | null {
    try { const parsed = desktopConnectorPreviewSchema.safeParse(JSON.parse(preview)); return parsed.success ? parsed.data : null } catch { return null }
}

/**
 * What the held action would do, laid out to be read: a message as its To, Subject and text; any
 * other action as its named values; sandbox code as code. A request kept before previews had a
 * shape shows its text as it was.
 */
function ConnectorPreview({ preview, showTool }: { preview: string; showTool: boolean }) {
    const { t } = useDesktopLocale()
    const shaped = readPreview(preview)
    if (!shaped) return preview === '{}' ? null : <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">{preview}</pre>
    return (
        <div className="mt-2 flex flex-col gap-2" data-testid="desktop-connector-preview">
            {shaped.items.map((item, index) => {
                const fields = item.fields ?? []
                const headers = HEADERS.flatMap(([key, label]) => { const found = fields.find(([name]) => key.test(name)); return found ? [{ label, value: plain(found[1]), name: found[0] }] : [] })
                const body = fields.find(([name]) => BODY.test(name))
                const message = !!body && headers.length > 0
                const shown = new Set(message ? [...headers.map(header => header.name), body![0]] : [])
                const rest = fields.filter(([name]) => !shown.has(name))
                if (!item.code && !fields.length) return null
                return (
                    <div key={index} className="overflow-hidden rounded-md border border-border bg-background">
                        {showTool && item.tool && <p className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">{toolLabelOf(item.tool)}</p>}
                        {item.code && <>
                            <p className="px-3 pt-2 text-xs text-muted-foreground">{t('boardUI.askCode')}</p>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 pb-2 pt-1 font-mono text-xs text-foreground">{item.code}</pre>
                        </>}
                        {message && <>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-sm">
                                {headers.map(header => (
                                    <div key={header.name} className="contents">
                                        <dt className="text-muted-foreground">{t(header.label)}</dt>
                                        <dd className={`min-w-0 break-words text-foreground ${header.label === 'boardUI.askSubject' ? 'font-medium' : ''}`}>{header.value}</dd>
                                    </div>
                                ))}
                            </dl>
                            <p className="max-h-28 overflow-auto whitespace-pre-wrap break-words px-3 py-2 text-sm text-foreground">{body![1]}</p>
                        </>}
                        {rest.length > 0 && (message
                            ? <details className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
                                <summary className="cursor-pointer select-none">{t('boardUI.askMore')}</summary>
                                <FieldList fields={rest} />
                            </details>
                            : <div className="px-3 py-2"><FieldList fields={rest} /></div>)}
                    </div>
                )
            })}
        </div>
    )
}

function FieldList({ fields }: { fields: readonly (readonly [string, string])[] }) {
    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {fields.map(([name, value]) => (
                <div key={name} className="contents">
                    <dt className="text-muted-foreground">{words(name)}</dt>
                    <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{plain(value)}</dd>
                </div>
            ))}
        </dl>
    )
}

/**
 * The connector actions waiting for an answer in this conversation, and the standing answers that
 * reach it. A held action is asked about here; the coworker runs it only after an allow, and is
 * told the answer through `onAnswered`.
 */
export function DesktopConnectorApprovals({ sessionId, generating, disabled, onAnswered, coworkerName }: {
    sessionId: string; generating: boolean; disabled: boolean; onAnswered: (text: string) => void; coworkerName?: string
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
    // A press in the coworker's browser: the control's own label and the page's host, as the page gave them.
    const press = waiting?.tool === DESKTOP_BROWSER_PRESS_TOOL ? readPreview(waiting.preview)?.press ?? { label: '', host: '', via: 'click' as const } : null
    const title = !waiting ? '' : !press ? t('boardUI.askTitle', { tool: toolLabelOf(waiting.tool) })
        : t(!press.label ? 'boardUI.askPressUnlabelled' : press.via === 'key' ? 'boardUI.askPressKey' : 'boardUI.askPressTitle',
            { name: coworkerName || t('boardUI.askPressCoworker'), label: press.label, host: press.host || t('boardUI.askPressHere') })
    return (
        <div className="flex w-full flex-col gap-2" data-testid="desktop-connector-approvals">
            {waiting && (
                <section className="rounded-lg border border-border bg-card p-3 text-sm" aria-label={title} data-testid={press ? 'desktop-browser-press-approval' : undefined}>
                    <p className="break-words font-medium text-foreground">{title}</p>
                    <p className="mt-0.5 text-muted-foreground">{t(KIND[waiting.kind])}</p>
                    {press ? <p className="mt-0.5 text-xs text-muted-foreground">{t('boardUI.askPressNote')}</p>
                        : <ConnectorPreview preview={waiting.preview} showTool={waiting.tool.includes('+')} />}
                    <div className="mt-3 flex flex-wrap gap-2">
                        {ANSWERS.filter(([decision]) => !press || decision === 'once' || decision === 'deny').map(([decision, label]) => (
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
