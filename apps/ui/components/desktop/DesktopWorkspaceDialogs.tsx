'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { desktopCoworkerShareImportInputSchema, desktopCoworkerSnapshotResultSchema, desktopRemoteActorSchema, type DesktopCoworkerShareExportInput, type DesktopCoworkerShareImportInput, type DesktopCoworkerShareRevokeInput, type DesktopRemoteActor, type DesktopRemoteCommand, type DesktopRemoteMachineBridge, type DesktopRemoteResult } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { createDesktopCoworkerShareClient, type DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { createDesktopCoworkerShareServerAttempts } from '@/lib/desktop/coworker-share/attempts'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { DesktopCoworkerShareNavigation } from './coworker-share/DesktopCoworkerShareNavigation'
import { DesktopCoworkerImportDialog } from './coworker-share/DesktopCoworkerImportDialog'
import { RemoteMachinesDialog } from './remote-machines/RemoteMachinesDialog'

export type DesktopWorkspaceNativeTools = {
    remoteMachines?: { actor: () => Promise<DesktopRemoteActor>; execute: (command: DesktopRemoteCommand) => Promise<DesktopRemoteResult> }
    coworkerShare?: { pickImport: () => Promise<{ snapshotId: string; fileName: string } | null> }
}

export function DesktopWorkspaceDialogStatus({ title, error, onClose, onRetry }: { title: string; error?: string | null; onClose: () => void; onRetry?: () => void }) {
    return <Dialog open onOpenChange={next => { if (!next) onClose() }}>
        <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
            <p role={error ? 'alert' : 'status'} className="text-sm text-muted-foreground">{error ?? 'Opening…'}</p>
            {error && onRetry && <Button type="button" variant="outline" onClick={onRetry}>Retry</Button>}
        </DialogContent>
    </Dialog>
}

export function DesktopServersNavigation({ workspaceId, onClose }: { workspaceId: number; onClose: () => void }) {
    const [lease, setLease] = useState<{ actor: DesktopRemoteActor; bridge: DesktopRemoteMachineBridge } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
        let current = true
        const controller = new AbortController()
        setLease(null); setError(null)
        const native = (window as Window & { desktopApp?: DesktopWorkspaceNativeTools }).desktopApp?.remoteMachines
        void (async () => {
            if (!native?.actor || !native.execute) throw new Error('Servers is available in the Mac app. Reopen this workspace if the app is still starting.')
            const actor = desktopRemoteActorSchema.parse(await Promise.race([
                native.actor(),
                new Promise<never>((_, reject) => { controller.signal.addEventListener('abort', () => reject(new Error('The app could not read this workspace’s server identity. Try again.')), { once: true }) }),
            ]))
            if (actor.workspaceId !== workspaceId) throw new Error('The selected workspace changed. Reopen Servers in the current workspace.')
            if (current && !isDesktopQuitting()) setLease({ actor, bridge: { execute: async (command, signal) => { signal?.throwIfAborted(); return native.execute(command) } } })
        })().catch(cause => { if (current && !isDesktopQuitting()) setError(cause instanceof Error ? cause.message : 'Servers could not be opened.') })
        const timer = setTimeout(() => controller.abort(), 15_000)
        return () => { current = false; clearTimeout(timer); controller.abort() }
    }, [workspaceId, attempt])
    if (!lease) return <DesktopWorkspaceDialogStatus title="Servers" error={error} onClose={onClose} onRetry={() => setAttempt(value => value + 1)} />
    return <RemoteMachinesDialog open actor={lease.actor} bridge={lease.bridge} onOpenChange={next => { if (!next) onClose() }} />
}

export function DesktopCoworkerShareLauncher({ workspaceId, agentId, agentName, onClose, onImported, onOpenCoworker }: { workspaceId: number; agentId: string; agentName: string; onClose: () => void; onImported?: (agentId: string) => void | Promise<void>; onOpenCoworker: (agentId: string) => void }) {
    const [revision, setRevision] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [open, setOpen] = useState(true)
    const [preview, setPreview] = useState<string | null>(null)
    const previewRef = useRef<string | null>(null)
    const current = useRef(true)
    const generation = useRef(0)
    const [recoveryClient, setRecoveryClient] = useState<DesktopCoworkerShareClient | null>(null)
    const attempts = useMemo(() => createDesktopCoworkerShareServerAttempts(workspaceId,agentId),[workspaceId,agentId])
    const [savedExports, setSavedExports] = useState<DesktopCoworkerShareExportInput[]>([])
    const [savedRevocations, setSavedRevocations] = useState<DesktopCoworkerShareRevokeInput[]>([])
    const [recoveryError, setRecoveryError] = useState<string | null>(null)
    const [recoveredSnapshot, setRecoveredSnapshot] = useState<string | null>(null)
    const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null)
    const [recoveryBusy, setRecoveryBusy] = useState(false)
    const recoveryFlight = useRef(false)
    useEffect(() => { current.current = true; return () => { current.current = false } }, [])
    useEffect(() => {
        let active = true
        const client = createDesktopCoworkerShareClient({ workspaceId, routeAgentId: agentId })
        setRecoveryClient(client)
        let reading = false
        const read = async () => {
            if (!open || reading) return
            reading = true
            try {
                const [plan,exports,revocations] = await Promise.allSettled([client.plan(),attempts.listExport({ workspaceId,agentId }),attempts.listRevocations({ workspaceId,agentId })])
                if (!active || isDesktopQuitting()) return
                if (exports.status === 'fulfilled') setSavedExports(exports.value)
                if (revocations.status === 'fulfilled') setSavedRevocations(revocations.value)
                if (plan.status === 'rejected') throw plan.reason
                if (exports.status === 'rejected' || revocations.status === 'rejected') throw new Error('Durable share recovery is unavailable. Retry before creating a new share.')
                if (!plan.value.sourceRevision) throw new Error('The current coworker revision could not be confirmed.')
                setRevision(plan.value.sourceRevision); setError(null)
            } catch (cause) { if (active && !isDesktopQuitting()) setError(cause instanceof Error ? cause.message : 'The coworker could not be read.') }
            finally { reading = false }
        }
        void read()
        const interval = setInterval(() => { if (open && document.visibilityState === 'visible') void read() }, 5000)
        return () => { active = false; generation.current++; clearInterval(interval); client.dispose() }
    }, [workspaceId, agentId, attempt, open, attempts])
    async function recover(kind: 'export' | 'revoke', input: DesktopCoworkerShareExportInput | DesktopCoworkerShareRevokeInput) {
        if (!recoveryClient || recoveryFlight.current || isDesktopQuitting()) return
        const captured = generation.current
        const active = () => current.current && captured === generation.current && !isDesktopQuitting()
        recoveryFlight.current = true; setRecoveryBusy(true); setRecoveryError(null)
        try {
            if (kind === 'export') {
                const saved = input as DesktopCoworkerShareExportInput
                const result = desktopCoworkerSnapshotResultSchema.parse(await recoveryClient.export(saved))
                if (result.manifest.packageKey !== saved.reviewId.slice(0,32) || result.manifest.contentDigest !== saved.expectedDigest) throw new Error('The recovered export does not match its saved review.')
                if (!active()) return
                await attempts.forgetExport(saved)
                if (!active()) return
                setRecoveredSnapshot(result.manifest.packageKey); setSavedExports(values => values.filter(value => value.requestId !== saved.requestId))
            } else {
                const saved = input as DesktopCoworkerShareRevokeInput
                const receipt = await recoveryClient.revoke(saved)
                if (receipt.operation !== 'revoke' || receipt.status !== 'revoked' || receipt.requestId !== saved.requestId || receipt.snapshotId !== saved.snapshotId) throw new Error('The withdrawal acknowledgement does not match its saved request.')
                if (!active()) return
                await attempts.forgetRevoke({ workspaceId,agentId,snapshotId: saved.snapshotId },saved)
                if (!active()) return
                setSavedRevocations(values => values.filter(value => value.requestId !== saved.requestId)); setRecoveryNotice('The local share was withdrawn.')
            }
        } catch (cause) { if (active()) setRecoveryError(cause instanceof Error ? cause.message : 'The saved share acknowledgement is unknown. Retry the same attempt.') }
        finally { recoveryFlight.current = false; if (active()) setRecoveryBusy(false) }
    }
    if (open && error && (savedExports.length || savedRevocations.length || recoveredSnapshot || recoveryNotice)) return <Dialog open onOpenChange={next => { if (!next) onClose() }}>
        <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>Share {agentName}</DialogTitle></DialogHeader>
            <p role="alert" className="text-sm text-muted-foreground">The current coworker source is unavailable or stale. New share review is disabled. {error}</p>
            {savedExports.map(input => <Button type="button" variant="outline" key={input.requestId} disabled={recoveryBusy} onClick={() => void recover('export',input)}>Recover saved export {input.requestId.slice(0,8)}</Button>)}
            {savedRevocations.map(input => <Button type="button" variant="outline" key={input.requestId} disabled={recoveryBusy} onClick={() => void recover('revoke',input)}>Recover withdrawal {input.requestId.slice(0,8)}</Button>)}
            {recoveredSnapshot && recoveryClient && <a href={recoveryClient.downloadUrl(recoveredSnapshot)} download onClick={event => { if (isDesktopQuitting()) event.preventDefault() }} className="text-sm underline">Download recovered coworker file</a>}
            {recoveryNotice && <p role="status" className="text-sm">{recoveryNotice}</p>}
            {recoveryError && <p role="alert" className="text-sm text-destructive">{recoveryError}</p>}
            <Button type="button" variant="outline" disabled={recoveryBusy} onClick={() => setAttempt(value => value + 1)}>Retry current source</Button>
        </DialogContent>
    </Dialog>
    if (!revision || open && error) return <DesktopWorkspaceDialogStatus title={`Share ${agentName}`} error={error} onClose={onClose} onRetry={() => setAttempt(value => value + 1)} />
    return <DesktopCoworkerShareNavigation workspaceId={workspaceId} agentId={agentId} agentName={agentName} sourceRevision={revision}
        open={open} onOpenChange={next => { setOpen(next); if (!next) queueMicrotask(() => { if (current.current && !previewRef.current) onClose() }) }}
        importSnapshot={preview} onImportSnapshotChange={snapshot => { previewRef.current = snapshot; setPreview(snapshot); if (!snapshot) onClose() }} onImported={onImported} onOpenCoworker={onOpenCoworker} />
}

export function DesktopPortableCoworkerImport({ workspaceId, onClose, onImported, onOpenCoworker }: { workspaceId: number; onClose: () => void; onImported?: (agentId: string) => void | Promise<void>; onOpenCoworker: (agentId: string) => void }) {
    const [picked, setPicked] = useState<{ snapshotId: string; fileName: string } | null>(null)
    const [client, setClient] = useState<DesktopCoworkerShareClient | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [savedImports, setSavedImports] = useState<DesktopCoworkerShareImportInput[]>([])
    const [loading, setLoading] = useState(true)
    const [mode, setMode] = useState<'restore' | 'pick'>('restore')
    const attempts = useMemo(() => createDesktopCoworkerShareServerAttempts(workspaceId, 'portable-import'), [workspaceId])
    const latest = useRef({ onClose }); latest.current = { onClose }
    const picker = useRef<{ scope: string; result: Promise<{ snapshotId: string; fileName: string } | null> } | null>(null)
    useEffect(() => {
        let current = true
        setError(null); setLoading(true)
        const owned = createDesktopCoworkerShareClient({ workspaceId, routeAgentId: 'portable-import' })
        setClient(owned)
        const pick = (window as Window & { desktopApp?: DesktopWorkspaceNativeTools }).desktopApp?.coworkerShare?.pickImport
        void (async () => {
            const pending = (await attempts.listWorkspaceImports(workspaceId)).map(value => desktopCoworkerShareImportInputSchema.parse(value))
            if (pending.some(input => input.targetWorkspaceId !== workspaceId)) throw new Error('The saved import belongs to another workspace.')
            if (!current || isDesktopQuitting()) return
            setSavedImports(pending)
            if (pending.length && mode === 'restore') { setLoading(false); return }
            if (!pick) throw new Error('Import coworker is available in the Mac app. Reopen this workspace to try again.')
            const scope = `${workspaceId}:${attempt}:${mode}`
            if (picker.current?.scope !== scope) picker.current = { scope, result: Promise.resolve().then(() => pick()) }
            const result = await picker.current.result
            if (!current || isDesktopQuitting()) return
            if (!result) { if (pending.length) { setMode('restore'); setLoading(false) } else latest.current.onClose(); return }
            if (!/^[a-f0-9]{32}$/.test(result.snapshotId) || typeof result.fileName !== 'string') throw new Error('The portable coworker file could not be confirmed.')
            setPicked(result)
        })().catch(cause => { if (current && !isDesktopQuitting()) { setLoading(false); setError(cause instanceof Error ? cause.message : 'The portable coworker file could not be opened.') } })
        return () => { current = false; owned.dispose() }
    }, [workspaceId, attempt, attempts, mode])
    if (!picked && !loading && !error && savedImports.length) return <Dialog open onOpenChange={next => { if (!next) onClose() }}>
        <DialogContent className="sm:max-w-lg">
            <DialogHeader><DialogTitle>Import coworker</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">An earlier import is saved on this Mac. Review it to recover the same fresh copy.</p>
            <div className="flex flex-col gap-2">{savedImports.map(input => <Button type="button" variant="outline" key={input.requestId} onClick={() => {
                if (!isDesktopQuitting()) setPicked({ snapshotId: input.snapshotId,fileName: 'Saved coworker archive' })
            }}>Review saved import {input.requestId.slice(0,8)}</Button>)}</div>
            <Button type="button" variant="outline" onClick={() => { if (!isDesktopQuitting()) { setAttempt(value => value + 1); setMode('pick') } }}>Pick another file</Button>
        </DialogContent>
    </Dialog>
    if (!client || !picked) return <DesktopWorkspaceDialogStatus title="Import coworker" error={error} onClose={onClose} onRetry={() => setAttempt(value => value + 1)} />
    return <DesktopCoworkerImportDialog open client={client} attempts={attempts} targetWorkspaceId={workspaceId} snapshotId={picked.snapshotId}
        onOpenChange={next => { if (!next) onClose() }} onImported={onImported} onOpenCoworker={onOpenCoworker} />
}
