'use client'

import { ActionApprovalBlock, type ApprovalDecision } from '@rerun/ui/chat'
import { Button, Icon, ScrollFade } from '@rerun/ui/primitives'
import { useEffect, useRef, useState } from 'react'
import { ShieldAlertIcon } from '@/lib/icons'
import { desktopApprovalAnswerSchema, type DesktopApprovalAnswer, type DesktopPendingApproval } from '@/lib/desktop/approvals'

export type DesktopApprovalCardProps = {
    approval: DesktopPendingApproval
    disabled?: boolean
    onDecide: (payload: DesktopApprovalAnswer) => Promise<void>
}

function ApprovalCard({ approval, disabled, onDecide }: DesktopApprovalCardProps) {
    const latest = useRef({ approval, disabled, onDecide })
    latest.current = { approval, disabled, onDecide }
    const requests = useRef(new Map<string, string>())
    const claimed = useRef(false)
    const mounted = useRef(true)
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle')
    const [error, setError] = useState('')
    const [localAttempt, setLocalAttempt] = useState<DesktopApprovalAnswer | null>(null)
    const [formVersion, setFormVersion] = useState(0)

    useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
    }, [])

    function identify(values: ApprovalDecision[]): DesktopApprovalAnswer {
        // The server supplies action labels and details. Only ordered decisions and canonical
        // decline notes belong in the request; approved decisions never carry a note.
        const decisions: DesktopApprovalAnswer['decisions'] = values.map(value => {
            if (value.decision === 'approved') return { decision: 'approved' }
            const note = value.note?.trim()
            return { decision: 'declined', ...(note && { note }) }
        })
        const key = JSON.stringify(decisions)
        let requestId = requests.current.get(key)
        if (!requestId) {
            requestId = crypto.randomUUID()
            requests.current.set(key, requestId)
        }
        return { approvalId: approval.id, requestId, decisions }
    }

    async function send(payload: DesktopApprovalAnswer) {
        const current = latest.current
        if (!mounted.current || current.disabled || claimed.current || payload.approvalId !== current.approval.id) return
        if (current.approval.attempt && payload.requestId !== current.approval.attempt.requestId) return
        claimed.current = true
        setStatus('sending')
        setError('')
        // ActionApprovalBlock has a synchronous submit callback and permanently latches after
        // submitting. Keep the chosen batch intact so errors can retry the same accepted intent.
        setLocalAttempt(payload)
        try {
            await current.onDecide(payload)
            if (mounted.current) setStatus('sent')
        } catch (cause) {
            claimed.current = false
            if (mounted.current) {
                setStatus('idle')
                setError(cause instanceof Error && cause.message ? cause.message : 'Could not send these decisions. Try again.')
            }
        }
    }

    function submit(decisions: ApprovalDecision[]) {
        const current = latest.current
        if (!mounted.current || current.disabled || claimed.current || approval.id !== current.approval.id || current.approval.attempt) return
        const parsed = desktopApprovalAnswerSchema.safeParse(identify(decisions))
        if (!parsed.success) {
            setError('Keep decline notes within 20,000 characters, then choose your decisions again.')
            // Validation happens before any transport or immutable recovery intent. The shared
            // form has already latched, so remount it to allow a corrected batch without changing
            // the original form or silently truncating the user's reason.
            setFormVersion(version => version + 1)
            return
        }
        void send(parsed.data)
    }

    const attempt: DesktopApprovalAnswer | null = approval.attempt
        ? { ...approval.attempt, approvalId: approval.id }
        : localAttempt
    const locked = disabled || status !== 'idle'
    return <div className="space-y-2" aria-busy={status === 'sending'}>
        {attempt ? <div className="relative space-y-2.5 overflow-hidden rounded-lg border border-border px-4 pt-3 pb-4">
            <div className="flex items-center gap-2.5 text-sm">
                <Icon size="sm" tone="orange" icon={ShieldAlertIcon} className="bg-orange-500/10 text-foreground" />
                <span className="font-medium text-foreground">Approval required</span>
            </div>
            {approval.approvals.map((item, index) => {
                const decision = attempt.decisions[index]
                return <div key={index} className="space-y-2.5">
                    <p className="text-sm text-foreground">{item.action}</p>
                    {item.detail && <ScrollFade className="max-h-[22vh] rounded bg-background">
                        <code className="block whitespace-pre-wrap break-all px-2 py-1.5 text-xs font-mono text-foreground">{item.detail}</code>
                    </ScrollFade>}
                    <p className="text-sm font-medium text-foreground">{decision?.decision === 'approved' ? 'Approved' : decision?.decision === 'declined' ? 'Not now' : 'Decision unavailable'}</p>
                    {decision?.decision === 'declined' && decision.note && <p className="whitespace-pre-wrap wrap-anywhere text-sm text-muted-foreground">{decision.note}</p>}
                </div>
            })}
            <p role="status" className="text-xs text-muted-foreground">{status === 'sent'
                ? 'Decisions sent.' : status === 'sending' ? 'Sending decisions…' : 'Retry the same decisions to finish sending them.'}</p>
            <Button type="button" size="sm" variant="outline" disabled={locked} onClick={() => { void send(attempt) }}>Retry decisions</Button>
        </div> : <ActionApprovalBlock key={formVersion} inline approvals={approval.approvals} disabled={locked} onSubmit={submit} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
}

export function DesktopApprovalCard(props: DesktopApprovalCardProps) {
    // A new authoritative batch owns new form state and latches. An old asynchronous completion
    // can only touch the unmounted batch it started from, never a newly selected action.
    return <ApprovalCard key={props.approval.id} {...props} />
}
