'use client'

import { useEffect, useRef, useState } from 'react'
import { desktopServiceRequestMutationSchema, type DesktopServiceChoice, type DesktopServiceRequestMutation } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Loader2Icon } from '@/lib/icons'
import {
    createDesktopServiceRequestsClient, serviceRequestScopeKey,
    type DesktopOpenApps, type DesktopServiceRequestDetail, type DesktopServiceRequestScope, type DesktopServiceRequestsClient,
} from '@/lib/desktop/service-requests-client'
import { DesktopServiceRequestReceipt } from './DesktopServiceRequestReceipt'
import { DesktopServiceSuggestionCard } from './DesktopServiceSuggestionCard'

export type DesktopServiceRequestBlockProps = {
    agentId: string
    sessionId: string
    request: DesktopServiceRequestDetail
    disabled?: boolean
    inline?: boolean
    onOpenApps: DesktopOpenApps
    onAccepted: (input: {
        agentId: string
        sessionId: string
        serviceRequestId: string
        requestId: string
        response: Response
        signal: AbortSignal
        cancelStream: () => void
    }) => Promise<void>
}

function scopeOf(props: DesktopServiceRequestBlockProps): DesktopServiceRequestScope {
    return { agentId: props.agentId, sessionId: props.sessionId, serviceRequestId: props.request.serviceRequestId, source: props.request.source }
}

function usableConnections(detail: DesktopServiceRequestDetail, index: number) {
    const row = detail.services[index]
    return row?.connectionsStatus === 'ready' ? (row.connections ?? []).filter(connection => connection.slug === row.slug
        && connection.usable && connection.state === 'ready' && connection.healthState === 'healthy') : []
}

function selectedConnection(detail: DesktopServiceRequestDetail, index: number) {
    const choice = detail.choices[index]
    const connections = usableConnections(detail, index)
    if (choice?.choice === 'use-connection') {
        const selected = connections.find(connection => connection.key === choice.installation.key && connection.revision === choice.installation.revision)
        if (selected) return selected
    }
    return connections.length === 1 ? connections[0] : undefined
}

function canFinish(detail: DesktopServiceRequestDetail, choices: DesktopServiceChoice[]) {
    return choices.every(choice => choice.choice !== 'pending')
        && detail.services.every((row, index) => row.catalog.status !== 'unavailable' && row.connectionsStatus === 'ready'
            && (choices[index]?.choice !== 'use-connection' || usableConnections(detail, index).some(connection => {
                const choice = choices[index]
                return choice.choice === 'use-connection' && connection.key === choice.installation.key && connection.revision === choice.installation.revision
            })))
}

function ServiceRequestBlock(props: DesktopServiceRequestBlockProps) {
    const latest = useRef(props)
    latest.current = props
    const scope = scopeOf(props)
    const scopeKey = serviceRequestScopeKey(scope)
    const client = useRef<DesktopServiceRequestsClient | null>(null)
    const busy = useRef(false)
    const fresh = useRef(false)
    const readEpoch = useRef(0)
    const active = useRef(false)
    const flow = useRef<{ controller: AbortController; cancelled: boolean } | null>(null)
    const [detail, setDetail] = useState<DesktopServiceRequestDetail | null>(props.request)
    const detailRef = useRef(detail)
    const [attempt, setAttempt] = useState<DesktopServiceRequestMutation | null>(null)
    const [loading, setLoading] = useState(true)
    const [working, setWorking] = useState(false)
    const [configuring, setConfiguring] = useState(false)
    const [error, setError] = useState('')
    const [accepted, setAccepted] = useState(false)

    function current(owner: DesktopServiceRequestsClient) {
        return active.current && client.current === owner && !latest.current.disabled
            && serviceRequestScopeKey(scopeOf(latest.current)) === scopeKey
    }

    async function refresh(owner: DesktopServiceRequestsClient) {
        const epoch = ++readEpoch.current
        fresh.current = false
        if (current(owner)) setLoading(true)
        try {
            const next = await owner.read()
            if (!current(owner) || epoch !== readEpoch.current) return null
            const pending = owner.pending() ?? (next ? owner.recoverFinish(next) : null)
            detailRef.current = next
            setDetail(next)
            setAttempt(pending)
            fresh.current = true
            setError('')
            return next
        } catch {
            if (current(owner) && epoch === readEpoch.current) setError('Could not refresh this app request. Keep the saved choices and try again.')
            return null
        } finally {
            if (current(owner) && epoch === readEpoch.current) setLoading(false)
        }
    }

    useEffect(() => {
        active.current = true
        fresh.current = false
        if (props.disabled) { setLoading(false); return () => { active.current = false } }
        let owner: DesktopServiceRequestsClient
        try {
            owner = createDesktopServiceRequestsClient(scope, window.localStorage)
            client.current = owner
            setAttempt(owner.pending())
            void refresh(owner)
        } catch {
            setError('Local app retry storage is unavailable. Keep this request pending.')
            setLoading(false)
        }
        return () => {
            active.current = false
            readEpoch.current++
            flow.current?.controller.abort()
            flow.current = null
            client.current?.dispose()
            client.current = null
        }
        // The keyed wrapper fixes source/owner identity. Re-enabling creates a new cancellable client.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scopeKey, props.disabled])

    async function apply(owner: DesktopServiceRequestsClient, payload: DesktopServiceRequestMutation) {
        setAttempt(payload)
        const result = await owner.mutate(payload)
        if (!current(owner)) { if (result.action === 'finish') { result.cancelStream(); await result.response.body?.cancel().catch(() => undefined) } return null }
        setAttempt(null)
        if (result.action === 'finish') {
            setAccepted(true)
            fresh.current = false
            try {
                await latest.current.onAccepted({ agentId: scope.agentId, sessionId: scope.sessionId, serviceRequestId: scope.serviceRequestId,
                    requestId: result.requestId, response: result.response, signal: result.signal, cancelStream: result.cancelStream })
            } catch {
                result.cancelStream()
                await result.response.body?.cancel().catch(() => undefined)
                if (current(owner)) setError('App setup was sent. Reload the conversation to see its result.')
            }
            return null
        }
        return refresh(owner)
    }

    function mutation(detail: DesktopServiceRequestDetail, action: 'progress' | 'finish', currentIndex: number, choices: DesktopServiceChoice[]) {
        return desktopServiceRequestMutationSchema.parse({ action, requestId: crypto.randomUUID(), serviceRequestId: detail.serviceRequestId,
            source: detail.source, expectedRevision: detail.revision, currentIndex, choices })
    }

    async function decide(kind: 'advance' | 'skip' | 'select' | 'connection', index?: number, installation?: { key: string; revision: string }) {
        const owner = client.current
        const saved = detailRef.current
        if (!owner || !current(owner) || busy.current || !fresh.current || !saved || attempt || accepted || saved.retry.phase !== 'open') return
        busy.current = true
        setWorking(true)
        setError('')
        try {
            const choices = saved.choices.map(choice => ({ ...choice }))
            const currentIndex = saved.currentIndex
            const slug = saved.services[currentIndex].slug
            if (kind === 'skip') choices[currentIndex] = { slug, choice: 'skip' }
            if (kind === 'connection' && installation) choices[currentIndex] = { slug, choice: 'use-connection', installation }
            if (kind === 'advance') {
                const connection = selectedConnection(saved, currentIndex)
                if (connection && choices[currentIndex].choice !== 'skip') choices[currentIndex] = { slug, choice: 'use-connection', installation: { key: connection.key, revision: connection.revision } }
            }
            const target = kind === 'select' ? index! : kind === 'connection' ? currentIndex : Math.min(currentIndex + 1, saved.services.length - 1)
            const finishing = (kind === 'advance' || kind === 'skip') && currentIndex === saved.services.length - 1 && canFinish(saved, choices)
            const changed = target !== currentIndex || JSON.stringify(choices) !== JSON.stringify(saved.choices)
            const next = changed ? await apply(owner, mutation(saved, 'progress', target, choices)) : saved
            if (finishing && next && current(owner) && canFinish(next, next.choices)) await apply(owner, mutation(next, 'finish', next.currentIndex, next.choices))
        } catch {
            if (current(owner)) {
                fresh.current = false
                setError('App progress or Finish was refused or its acknowledgement is unknown. Retry the exact saved decisions.')
                try { setAttempt(owner.pending()) } catch { setError('Saved app decisions could not be read. Keep this request pending.') }
            }
        } finally {
            busy.current = false
            if (current(owner)) setWorking(false)
        }
    }

    async function retry() {
        const owner = client.current
        if (!owner || !current(owner) || busy.current || accepted) return
        busy.current = true
        setWorking(true)
        setError('')
        try {
            const payload = owner.pending() ?? (detailRef.current ? owner.recoverFinish(detailRef.current) : null)
            if (payload) await apply(owner, payload)
            else await refresh(owner)
        } catch {
            if (current(owner)) setError('Acknowledgement is still unavailable. Retry the same saved decisions.')
        } finally { busy.current = false; if (current(owner)) setWorking(false) }
    }

    async function connect() {
        const owner = client.current
        const saved = detailRef.current
        if (!owner || !current(owner) || busy.current || !fresh.current || !saved || attempt || accepted || saved.retry.phase !== 'open') return
        busy.current = true
        fresh.current = false
        const opened = { controller: new AbortController(), cancelled: false }
        flow.current = opened
        setConfiguring(true)
        setError('')
        try {
            const result = await latest.current.onOpenApps({ agentId: scope.agentId, slug: saved.services[saved.currentIndex].slug,
                serviceRequestId: scope.serviceRequestId, sourceFingerprint: scope.source.fingerprint, signal: opened.controller.signal })
            if (result.status !== 'closed') throw new Error('Apps flow did not close.')
        } catch {
            if (current(owner) && !opened.cancelled) setError('Apps setup could not be confirmed. Refresh this request before choosing a connection.')
        } finally {
            if (current(owner) && flow.current === opened) {
                await refresh(owner)
                flow.current = null
                setConfiguring(false)
            }
            busy.current = false
        }
    }

    if (detail?.receipt?.accepted) return <DesktopServiceRequestReceipt entries={detail.receipt.entries} />
    if (accepted) return <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">App setup result sent.</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
    if (!detail) return <div className="space-y-2"><p className="text-sm text-muted-foreground">This app request is no longer waiting.</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div>
    const row = detail.services[detail.currentIndex]
    const catalog = row.catalog
    const named = catalog.status === 'available' || catalog.status === 'unsupported-auth' ? catalog : null
    const available = usableConnections(detail, detail.currentIndex)
    const connection = selectedConnection(detail, detail.currentIndex)
    const selected = detail.choices.map((choice, index) => choice.choice === 'use-connection' && usableConnections(detail, index)
        .some(item => item.key === choice.installation.key && item.revision === choice.installation.revision))
    const choice = detail.choices[detail.currentIndex]
    const nextChoices = [...detail.choices]
    if (connection && choice.choice !== 'skip') nextChoices[detail.currentIndex] = { slug: row.slug, choice: 'use-connection', installation: { key: connection.key, revision: connection.revision } }
    const unavailableReason = catalog.status === 'unavailable' ? 'The app catalog is unavailable. Refresh before finishing.'
        : catalog.status === 'not-found' ? 'Not found in the catalog.'
            : catalog.unsupportedReason ?? catalog.methods.filter(method => !method.supported && method.reason).map(method => method.reason).join('\n')
    const locked = !!props.disabled || loading || working || !!attempt || (!fresh.current && !configuring) || detail.retry.phase !== 'open'
    return <div className="min-w-0 space-y-2">
        <DesktopServiceSuggestionCard name={named?.name ?? row.slug} slug={row.slug} reason={row.reason} icon={named?.icon ?? null} category={named?.category ?? 'other'}
            current={detail.currentIndex} count={detail.services.length} selected={selected} skipped={choice.choice === 'skip'}
            unavailableReason={unavailableReason} connectionMessage={row.connectionsStatus === 'unavailable' ? 'Connection state is unavailable. Refresh before finishing.'
                : choice.choice === 'use-connection' && !selected[detail.currentIndex] ? 'The selected connection changed or is no longer usable. Choose a current connection or Skip.'
                    : connection ? 'Current connection is healthy and available to this coworker.' : 'Configure and probe a connection in Apps. Apps permission is managed there.'}
            canConnect={!!named?.methods.some(method => method.supported)} canUseConnection={!!connection}
            canAdvance={detail.currentIndex < detail.services.length - 1 || canFinish(detail, nextChoices)} configuring={configuring} busy={working}
            disabled={locked} inline={props.inline} onConnect={() => { void connect() }} onCancel={() => { if (flow.current) { flow.current.cancelled = true; flow.current.controller.abort() } }}
            onSkip={() => { void decide('skip') }} onAdvance={() => { void decide('advance') }} onSelect={index => { void decide('select', index) }} />
        {available.length > 1 && <div className="flex flex-wrap gap-2" aria-label="Choose an existing connection">{available.map(item => <Button key={`${item.key}:${item.revision}`} size="sm" variant="outline"
            disabled={locked || configuring} onClick={() => { void decide('connection', undefined, { key: item.key, revision: item.revision }) }}>Use {item.key}</Button>)}</div>}
        {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2Icon className="size-4 animate-spin" />Loading suggested apps…</p>}
        {attempt && <div className="space-y-1"><p className="text-xs text-muted-foreground">Saved {attempt.action === 'finish' ? 'Finish' : 'app progress'} is waiting for acknowledgement. The same choices will be retried.</p>
            <ul className="space-y-1 text-xs text-muted-foreground">{attempt.choices.map(item => <li key={item.slug} className="wrap-anywhere">{item.slug}: {item.choice === 'skip' ? 'Skipped' : item.choice === 'pending' ? 'Pending' : `Use connection ${item.installation.key}`}</li>)}</ul>
            <Button size="sm" variant="outline" disabled={!!props.disabled || working || configuring} onClick={() => { void retry() }}>Retry {attempt.action === 'finish' ? 'Finish' : 'progress'}</Button></div>}
        {error && <p role="alert" className="whitespace-pre-wrap wrap-anywhere text-sm text-destructive">{error}</p>}
        {!attempt && !configuring && <Button size="sm" variant="ghost" disabled={!!props.disabled || loading || working} onClick={() => { const owner = client.current; if (owner) void refresh(owner) }}>Refresh connection state</Button>}
        {detail.currentIndex === detail.services.length - 1 && detail.choices.some((item, index) => index !== detail.currentIndex && item.choice === 'pending')
            && <p className="text-xs text-muted-foreground">Choose a connection or Skip for every app before finishing. Use the progress dots to return to pending apps.</p>}
    </div>
}

export function DesktopServiceRequestBlock(props: DesktopServiceRequestBlockProps) {
    return <ServiceRequestBlock key={`${serviceRequestScopeKey(scopeOf(props))}:${!!props.disabled}`} {...props} />
}
