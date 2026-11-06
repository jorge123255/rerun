'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { companyBriefAttemptSchema, companyBriefHandoffResultSchema, companyBriefEvidence, companyDiscoverySnapshotSchema, companyDiscoveryBoard, COMPANY_DISCOVERY_SOURCE_LABELS, type DesktopForemanChatRef } from '@rerun/contracts'
import { DiscoveryCard } from '@/components/builder/discoveries/DiscoveryCard'
import { Button } from '@/components/ui/button'
import { DesktopCompanyBriefReview } from './DesktopCompanyBriefReview'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'

const stateSchema = z.object({ snapshot: companyDiscoverySnapshotSchema.nullable(), sourceRevision: z.string().nullable(), attempt: companyBriefAttemptSchema.nullable(), expectedPages: z.array(z.object({ slug: z.string(), expectedPageHash: z.string().nullable() })) })
const attemptResponse = z.object({ attempt: companyBriefAttemptSchema })
type State = z.infer<typeof stateSchema>
type Action = 'synthesize' | 'retry' | 'edit' | 'dismiss' | 'handoff'
type Pending = { action: Action; signature: string; input: Record<string, unknown>; draftVersion: number; sourceRevision: string }
class ResearchError extends Error { constructor(message: string, readonly status: number) { super(message) } }
async function body(response: Response) {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Company research returned no acknowledgement.')
    const chunks: Uint8Array[] = []; let length = 0
    try { for (;;) { const value = await reader.read(); if (value.done) break; length += value.value.byteLength; if (length > 2 * 1024 * 1024) throw new Error('Company research is too large to display.'); chunks.push(value.value) } }
    finally { void reader.cancel().catch(() => {}) }
    const bytes = new Uint8Array(length); let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!response.ok) throw new ResearchError(typeof value?.error === 'string' ? value.error : 'Company research could not be updated.', response.status)
    return value
}
/** Observes saved research. Explicit actions alone call the model or propose Brain pages. */
export function DesktopCompanyResearch({ chat, active, refreshKey }: { chat: DesktopForemanChatRef; active: boolean; refreshKey?: string }) {
    const scope = `${chat.workspaceId}:${chat.chatId}`
    const [state, setState] = useState<State | null>(null)
    const [draft, setDraft] = useState('')
    const dirty = useRef(false), draftVersion = useRef(0)
    const [selected, setSelected] = useState<string[]>([])
    const [notice, setNotice] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const busyRef = useRef(false), current = useRef(scope); current.current = scope
    const epoch = useRef(0), readVersion = useRef(0), operation = useRef(0)
    const previousAttempt = useRef<string | null>(null)
    const currentSource = useRef<string | null>(null)
    const pending = useRef<Pending | null>(null)
    const request = useRef<AbortController | null>(null)
    const read = useCallback(async (signal?: AbortSignal) => {
        const generation = epoch.current, version = ++readVersion.current
        const next = stateSchema.parse(await body(await fetch(`/api/desktop/foreman/company?${new URLSearchParams(chat)}`, { cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) })))
        if (next.snapshot && (next.snapshot.workspaceId !== chat.workspaceId || next.snapshot.chatId !== chat.chatId) || next.attempt && (next.attempt.workspaceId !== chat.workspaceId || next.attempt.chatId !== chat.chatId)) throw new Error('Company research belongs to a different conversation.')
        if (current.current !== scope || generation !== epoch.current || version !== readVersion.current || signal?.aborted) return
        const nextId = next.attempt?.requestId ?? null
        const changedAttempt = previousAttempt.current !== nextId
        const changedSource = currentSource.current !== next.sourceRevision
        if (changedAttempt || changedSource) setSelected([])
        if (changedAttempt) {
            previousAttempt.current = nextId
            dirty.current = false; draftVersion.current = 0
            setDraft(next.attempt?.draft ?? next.attempt?.result?.brief ?? '')
        }
        currentSource.current = next.sourceRevision
        const obsolete = pending.current
        if (obsolete && (obsolete.sourceRevision !== next.sourceRevision || changedAttempt && obsolete.input.requestId !== nextId)) {
            request.current?.abort(); request.current = null; operation.current++
            pending.current = null; busyRef.current = false; setBusy(false)
            setNotice('Company research changed. Review the current brief before continuing.')
        }
        const awaiting = pending.current
        const acknowledgedAttempt = next.attempt
        if (awaiting && acknowledgedAttempt && acknowledgedAttempt.requestId === awaiting.input.requestId) {
            const acknowledged = (awaiting.action === 'synthesize' || awaiting.action === 'retry') && acknowledgedAttempt.status !== 'pending'
                || awaiting.action === 'edit' && acknowledgedAttempt.draftRevision === Number(awaiting.input.expectedDraftRevision) + 1 && acknowledgedAttempt.draft === awaiting.input.brief
                || awaiting.action === 'dismiss' && acknowledgedAttempt.status === 'dismissed'
            if (acknowledged) { pending.current = null; if (draftVersion.current === awaiting.draftVersion) dirty.current = false }
        }
        setState(next)
        if (!dirty.current) setDraft(next.attempt?.draft ?? next.attempt?.result?.brief ?? '')
    }, [scope, chat.workspaceId, chat.chatId])
    useEffect(() => {
        epoch.current++; operation.current++; setState(null); setDraft(''); setSelected([]); setNotice(null); setBusy(false); busyRef.current = false; dirty.current = false; previousAttempt.current = null; currentSource.current = null; pending.current = null
        return () => { epoch.current++; operation.current++; request.current?.abort() }
    }, [scope])
    useEffect(() => {
        if (!active || isDesktopQuitting()) return
        const controller = new AbortController()
        void read(controller.signal).catch(error => { if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : 'Research unavailable.') })
        return () => controller.abort()
    }, [read, active, refreshKey])
    useEffect(() => {
        if (!active || state?.attempt?.status !== 'pending') return
        const controller = new AbortController()
        const timer = setInterval(() => { if (!isDesktopQuitting()) void read(controller.signal).catch(() => {}) }, 2000)
        return () => { clearInterval(timer); controller.abort() }
    }, [active, state?.attempt?.status, read])
    const observed = useRef<{ scope: string; active: boolean } | null>(null)
    useEffect(() => {
        const previous = observed.current
        observed.current = { scope, active }
        if (previous?.scope === scope && previous.active && !active) void fetch('/api/desktop/foreman/company', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'observe', chat, active: false }) }).catch(() => {})
    }, [active, scope, chat.workspaceId, chat.chatId])
    async function perform(attempt: Pending) {
        if (busyRef.current || isDesktopQuitting() || pending.current !== attempt || currentSource.current !== attempt.sourceRevision) return
        const own = scope, generation = epoch.current, token = ++operation.current
        const controller = new AbortController(); request.current = controller
        busyRef.current = true; setBusy(true); setNotice(null)
        try {
            const result = await body(await fetch('/api/desktop/foreman/company', { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(125_000)]), headers: { 'content-type': 'application/json' }, body: JSON.stringify(attempt.input) }))
            if (attempt.action === 'handoff') {
                const receipt = companyBriefHandoffResultSchema.parse(result)
                if (receipt.handoffRequestId !== attempt.input.handoffRequestId || receipt.requestId !== attempt.input.requestId) throw new Error('Company Brain acknowledged another proposal.')
                if (current.current === own && epoch.current === generation && token === operation.current) setNotice(receipt.status === 'recorded' ? 'Selected findings were sent to Company Brain for review.' : 'The proposal was not added because a page or proposal changed. Review the current Brain pages.')
            } else {
                const receipt = attemptResponse.parse(result).attempt
                if (receipt.requestId !== attempt.input.requestId || receipt.workspaceId !== chat.workspaceId || receipt.chatId !== chat.chatId) throw new Error('Company research acknowledged another request.')
            }
            if (current.current !== own || epoch.current !== generation || token !== operation.current) return
            pending.current = null
            if (draftVersion.current === attempt.draftVersion) dirty.current = false
            await read()
        } catch (error) {
            if (current.current === own && epoch.current === generation && token === operation.current) {
                if (error instanceof ResearchError && [400, 404, 413, 415].includes(error.status)) pending.current = null
                setNotice(error instanceof Error ? error.message : 'Retry this same action to check its saved result.')
                await read().catch(() => {})
            }
        } finally { if (current.current === own && epoch.current === generation && token === operation.current) { busyRef.current = false; request.current = null; setBusy(false) } }
    }
    function act(action: Action) {
        if (busyRef.current || !state?.sourceRevision || isDesktopQuitting()) return
        if (pending.current) { setNotice('Retry the previous action to check its saved result before changing this request.'); return }
        const attempt = state.attempt
        if (previousAttempt.current !== (attempt?.requestId ?? null) || currentSource.current !== state.sourceRevision) return
        const matchingSource = !!attempt && !!state.snapshot && attempt.discoveryId === state.snapshot.discoveryId && attempt.runId === state.snapshot.runId && attempt.sourceRevision === state.sourceRevision
        if (action !== 'synthesize' && (!matchingSource || attempt?.status === 'dismissed')) { setNotice('Create a new brief for the current company research.'); return }
        if (action === 'handoff' && dirty.current) { setNotice('Save your edits before proposing the brief.'); return }
        const values = action === 'synthesize' || action === 'retry'
            ? { chat, sourceRevision: state.sourceRevision, ...(action === 'retry' ? { previousRequestId: attempt?.requestId } : {}) }
            : action === 'edit' ? { chat, requestId: attempt?.requestId, expectedDraftRevision: attempt?.draftRevision, brief: draft }
            : action === 'handoff' ? { chat, requestId: attempt?.requestId, sourceRevision: state.sourceRevision, expectedDraftRevision: attempt?.draftRevision, selectedClaimIds: selected, includeDraft: true, expectedPages: state.expectedPages }
            : { chat, requestId: attempt?.requestId }
        const input = { action, ...values, ...(['synthesize', 'retry'].includes(action) ? { requestId: crypto.randomUUID() } : {}), ...(action === 'handoff' ? { handoffRequestId: crypto.randomUUID() } : {}) }
        const next = { action, input, signature: JSON.stringify(input), draftVersion: draftVersion.current, sourceRevision: state.sourceRevision }
        pending.current = next
        void perform(next)
    }
    async function stop() {
        const target = pending.current?.input.requestId ?? state?.attempt?.requestId
        if (typeof target !== 'string') return
        const own = scope, generation = epoch.current, token = ++operation.current
        request.current?.abort(); busyRef.current = true; setBusy(true)
        try {
            const result = attemptResponse.parse(await body(await fetch('/api/desktop/foreman/company', { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel', chat, requestId: target }) })))
            if (result.attempt.requestId !== target || result.attempt.chatId !== chat.chatId) throw new Error('Company research acknowledged another cancellation.')
            if (current.current !== own || epoch.current !== generation || token !== operation.current) return
            pending.current = null; setNotice('Company research stopped.'); await read()
        } catch (error) { if (current.current === own && epoch.current === generation) setNotice(error instanceof Error ? error.message : 'Stop was not confirmed. Retry Stop.') }
        finally { if (current.current === own && epoch.current === generation && token === operation.current) { busyRef.current = false; setBusy(false) } }
    }
    if (!active) return null
    if (!state?.snapshot) return notice ? <div className="pointer-events-none absolute inset-0 z-20" style={{ gridColumn: '2 / 3', gridRow: '1 / 2' }}>
        <section aria-label="Company research" className="pointer-events-auto absolute bottom-4 left-4 w-72 space-y-2 rounded-xl border bg-card p-3 shadow-lg">
            <p className="text-xs text-destructive" role="alert">{notice}</p>
            <Button size="sm" variant="outline" onClick={() => { setNotice(null); void read().catch(error => setNotice(error instanceof Error ? error.message : 'Research unavailable.')) }}>Refresh company research</Button>
        </section>
    </div> : null
    const cards = companyDiscoveryBoard(state.snapshot).filter(entry => entry.type === 'finding')
    const attempt = state.attempt
    const showBrief = !!attempt && attempt.status !== 'dismissed' && attempt.discoveryId === state.snapshot.discoveryId && attempt.runId === state.snapshot.runId && attempt.sourceRevision === state.sourceRevision
    return <div className="pointer-events-none absolute inset-0 z-20" style={{ gridColumn: '2 / 3', gridRow: '1 / 2' }}>
        {!showBrief && <section aria-label="Company research" className="pointer-events-auto absolute bottom-4 left-4 max-h-[65vh] w-72 overflow-auto rounded-xl border bg-card p-3 shadow-lg">
            <div className="mb-2 flex items-center justify-between gap-2"><p className="text-sm font-medium">Company research</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => { void read().catch(error => setNotice(error.message)) }}>Refresh</Button></div>
            <p className="mb-2 text-xs text-muted-foreground">{state.snapshot.status === 'running' ? 'Researching…' : `${cards.length} findings`}</p>
            {state.snapshot.pending.map(source => <p key={source} className="text-xs text-muted-foreground">{COMPANY_DISCOVERY_SOURCE_LABELS[source]}…</p>)}
            <div className="space-y-2">{cards.map(entry => entry.type === 'finding' && <DiscoveryCard key={entry.id} finding={entry.finding} still />)}</div>
            {state.snapshot.status !== 'running' && <Button className="mt-3 w-full" disabled={busy || !companyBriefEvidence(state.snapshot).length} onClick={() => act('synthesize')}>Create company brief</Button>}
        </section>}
        <DesktopCompanyBriefReview key={attempt?.requestId ?? 'no-brief'} attempt={showBrief ? attempt : null} findings={state.snapshot.findings} draft={draft} selectedClaimIds={selected} notice={null} busy={busy || attempt?.status === 'pending'}
            onDraft={value => { if (previousAttempt.current !== attempt?.requestId) return; dirty.current = true; draftVersion.current++; setDraft(value) }} onEdit={() => act('edit')} onDismiss={() => act('dismiss')} onRetry={() => act('retry')}
            onToggleClaim={id => { if (previousAttempt.current === attempt?.requestId) setSelected(old => old.includes(id) ? old.filter(value => value !== id) : [...old, id]) }} onHandoff={() => act('handoff')} />
        {(notice || pending.current || attempt?.status === 'pending') && <div className="pointer-events-auto absolute left-4 top-20 max-w-80 space-y-2 rounded-lg border bg-card p-3 shadow-lg">
            {notice && <p className="text-xs" role="status">{notice}</p>}
            {pending.current && !busy && <Button size="sm" onClick={() => { if (pending.current) void perform(pending.current) }}>Retry previous action</Button>}
            {(attempt?.status === 'pending' || pending.current && ['synthesize', 'retry'].includes(pending.current.action)) && <Button size="sm" variant="outline" onClick={() => void stop()}>Stop research</Button>}
        </div>}
    </div>
}
