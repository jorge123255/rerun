'use client'
import { useEffect, useRef, useState } from 'react'
import type { DesktopApiConnectionView, DesktopApiRemovalPlan } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog'
import { Trash2Icon } from '@/lib/icons'
import { removalConsequences } from '@/lib/desktop/api-connections/presentation'
import { ApiConnectionsSession } from '@/lib/desktop/api-connections/session'

export function ApiDeleteConnectionButton({ connection, session }: { connection: DesktopApiConnectionView; session: ApiConnectionsSession }) {
    const [open, setOpen] = useState(false), [plan, setPlan] = useState<DesktopApiRemovalPlan | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false)
    const controller = useRef<AbortController | null>(null), mounted = useRef(false), generation = useRef(0)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; controller.current?.abort() } }, [connection.connectionId, connection.revision])
    const load = async () => {
        controller.current?.abort(); const owned = new AbortController(), version = ++generation.current
        controller.current = owned; setLoading(true); setError(''); setPlan(null)
        try { const next = await session.review(connection, owned.signal); if (mounted.current && version === generation.current && !owned.signal.aborted) setPlan(next) }
        catch { if (mounted.current && version === generation.current && !owned.signal.aborted) setError('Could not check what still runs on it. Try again.') }
        finally { if (mounted.current && version === generation.current) setLoading(false) }
    }
    const confirm = async () => {
        if (!plan?.canRemove || loading || session.snapshot().busy || session.snapshot().uncertain) return
        const owned = new AbortController(), version = ++generation.current
        controller.current?.abort(); controller.current = owned; setLoading(true); setError('')
        try {
            const outcome = await session.removeReviewed(connection, plan, owned.signal)
            if (!mounted.current || version !== generation.current || owned.signal.aborted) return
            if ('changed' in outcome) { setPlan(outcome.changed); setError('What uses this connection changed. Review the updated consequences before removing it.'); return }
            if (outcome.result?.status === 'saved') setOpen(false)
            else setError(session.snapshot().error || 'The removal was not confirmed. Close this review to retry the same request.')
        } catch { if (mounted.current && version === generation.current && !owned.signal.aborted) setError('Could not confirm this removal. Review it again.') }
        finally { if (mounted.current && version === generation.current) setLoading(false) }
    }
    const close = () => { ++generation.current; controller.current?.abort(); setOpen(false); setLoading(false); setPlan(null); setError('') }
    return <AlertDialog open={open} onOpenChange={next => { if (session.snapshot().busy) return; if (next) { setOpen(true); void load() } else close() }}>
        <AlertDialogTrigger asChild><Button type="button" size="sm" variant="destructive" disabled={session.snapshot().busy || !!session.snapshot().uncertain}><Trash2Icon />Remove {connection.name}</Button></AlertDialogTrigger>
        <AlertDialogContent size="sm">
            <AlertDialogHeader><AlertDialogTitle>Remove {connection.name}?</AlertDialogTitle>
                <AlertDialogDescription asChild><div className="space-y-2 break-words text-xs">
                    {loading && !plan ? <p role="status">Checking what still runs on it…</p> : plan ? removalConsequences(plan).map((line, index) => <p key={index}>{line}</p>) : <p>The affected defaults are unavailable. Removal is disabled.</p>}
                    {error && <p role="alert" className="text-destructive">{error}</p>}
                </div></AlertDialogDescription>
            </AlertDialogHeader>
            {!plan && !loading && <Button type="button" size="sm" variant="outline" onClick={() => void load()}>Retry review</Button>}
            <AlertDialogFooter>
                <AlertDialogCancel type="button" disabled={session.snapshot().busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction type="button" variant="destructive" disabled={!plan?.canRemove || loading || session.snapshot().busy || !!session.snapshot().uncertain} onClick={event => { event.preventDefault(); void confirm() }}>Remove</AlertDialogAction>
            </AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
}
