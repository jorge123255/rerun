'use client'

import { ActionApprovalBlock, type ApprovalDecision } from '@rerun/ui/chat'
import { Button } from '@/components/ui/button'
import { desktopToolInstallApprovalItems, desktopToolInstallOutcomeText } from '../../../../../engine/src/desktop/tool-install/projections'
import { useDesktopToolInstall } from './useDesktopToolInstall'

export function DesktopToolInstallCard({ sessionId, operationId, active = true }: {
    sessionId: string
    operationId: string
    active?: boolean
}) {
    const controller = useDesktopToolInstall(sessionId, operationId, active)
    const snapshot = controller.snapshot

    if (controller.loading && !snapshot) return <p role="status" className="text-xs text-muted-foreground">Loading tool installation…</p>
    if (!snapshot) {
        return controller.error ? <div className="space-y-2">
            <p role="alert" className="break-words text-xs text-destructive">{controller.error}</p>
            <Button type="button" size="sm" variant="outline" disabled={!active} onClick={() => void controller.refresh()}>Retry</Button>
        </div> : null
    }

    const pending = snapshot.status === 'pending-approval'
    const uncertain = ['uncertain', 'interrupted'].includes(snapshot.status)
    const submit = (decisions: ApprovalDecision[]) => {
        const approved = decisions.every(item => item.decision === 'approved')
        const note = decisions.find(item => item.decision === 'declined')?.note
        void controller.decide(approved ? 'approved' : 'declined', note)
    }

    return <section aria-label="Tool installation" aria-busy={controller.action !== null} className="min-w-0 space-y-2">
        {pending ? <ActionApprovalBlock inline approvals={desktopToolInstallApprovalItems(snapshot)} disabled={!active || controller.action !== null} onSubmit={submit} /> : <>
            <p className="break-words text-sm text-foreground">{desktopToolInstallOutcomeText(snapshot)}</p>
            <div className="min-w-0 space-y-1.5">
                {snapshot.packages.map(item => <div key={item.package} className="min-w-0 text-xs">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <code className="break-all text-foreground">{item.package}</code>
                        <span className="text-muted-foreground">{item.status}</span>
                    </div>
                    {item.manifestSha256 && <p className="break-all text-muted-foreground">manifest {item.manifestSha256}</p>}
                    {item.lockSha256 && <p className="break-all text-muted-foreground">lock {item.lockSha256}</p>}
                    {item.message && <p className="break-words text-muted-foreground">{item.message}</p>}
                </div>)}
            </div>
            {snapshot.output && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 px-2 py-1.5 text-xs font-mono text-foreground/80">{snapshot.output}</pre>}
            <p className="text-xs text-muted-foreground">Available only in this coworker’s isolated guest. Host Codex and native tools cannot import these packages.</p>
        </>}
        {uncertain && <Button type="button" size="sm" variant="outline" disabled={!active || controller.action !== null} onClick={() => void controller.inspect()}>
            {controller.action === 'inspect' ? 'Inspecting…' : 'Inspect in isolated computer'}
        </Button>}
        {controller.error && <p role="alert" className="break-words text-xs text-destructive">{controller.error}</p>}
    </section>
}
