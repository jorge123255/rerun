'use client'

import { ScrollFade } from '@rerun/ui/primitives'
import { StepTransition } from '@rerun/ui/steps'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { DesktopCaptureReviewStep } from './DesktopCaptureReviewStep'
import { DesktopCaptureSelectStep } from './DesktopCaptureSelectStep'
import type { DesktopCaptureFlow, DesktopCaptureStep } from './useDesktopCaptureFlow'

export const DESKTOP_CAPTURE_STEP_COPY: Record<DesktopCaptureStep, { title: string; description: string }> = {
    select: { title: 'Capture coworkers', description: 'Pick the coworkers to include in this template.' },
    review: { title: 'Security review', description: 'Check what each coworker carries, then confirm it before capturing.' },
    done: { title: 'Captured', description: 'Your template is saved in your private library.' },
}

export function DesktopCaptureStepPanel({ flow, step, direction, onStepChange, onClose, doneLabel }: {
    flow: DesktopCaptureFlow
    step: DesktopCaptureStep
    direction: number
    onStepChange: (step: DesktopCaptureStep) => void
    onClose: () => void
    doneLabel: string
}) {
    const selectedCount = flow.selectedIds.length
    return <div className="flex min-h-0 flex-1 flex-col">
        <ScrollFade className="-mx-1 -mt-1 min-h-0 flex-1 px-1 pb-6 pt-1">
            <StepTransition stepKey={step} direction={direction}>
                {step === 'select' ? <DesktopCaptureSelectStep
                    workspaces={flow.workspaces}
                    workspaceId={flow.workspaceId}
                    loading={flow.loadingSources}
                    failed={flow.error !== null}
                    selectedIds={flow.selectedIds}
                    onWorkspaceChange={flow.setWorkspaceId}
                    onToggle={flow.toggleAgent}
                    onSelectionChange={flow.setSelection}
                /> : step === 'review' ? <DesktopCaptureReviewStep flow={flow} /> : <div className="flex flex-col gap-2">
                    <p className="text-sm">{flow.plans.length} coworker{flow.plans.length === 1 ? '' : 's'} captured. This template is private to your workspace.</p>
                    {flow.warnings.map(warning => <p key={warning} className="text-xs text-amber-500">{warning}</p>)}
                </div>}
            </StepTransition>
            {flow.error && <div role="alert" className="mt-4 text-sm text-destructive">
                <p>{flow.error}</p>
                {flow.locked && <p className="mt-1 text-xs">Retry keeps your reviewed selection. You can close this dialog and return to finish.</p>}
            </div>}
        </ScrollFade>
        <DialogFooter className="mt-auto -mx-6 -mb-6 border-t bg-muted/50 px-6 py-4">
            {step === 'select' && <>
                {flow.error && flow.workspaces.length === 0 && <Button type="button" variant="outline" disabled={flow.loadingSources} loading={flow.loadingSources} onClick={() => void flow.reloadSources()}>Try again</Button>}
                <Button type="button" disabled={selectedCount === 0 || flow.busy} loading={flow.busy} onClick={async () => { if (await flow.inspect()) onStepChange('review') }}>
                    Inspect {selectedCount || ''} coworker{selectedCount === 1 ? '' : 's'}
                </Button>
            </>}
            {step === 'review' && <>
                {!flow.allApproved && <p className="text-xs text-amber-500 sm:mr-auto sm:self-center">Review each coworker to enable the capture ({flow.approvedCount}/{flow.plans.length})</p>}
                <Button type="button" variant="ghost" disabled={flow.locked || flow.busy} onClick={() => onStepChange('select')}>Back</Button>
                <Button type="button" disabled={!flow.allApproved || flow.busy} loading={flow.busy} onClick={async () => { if (await flow.capture()) onStepChange('done') }}>
                    {flow.locked ? 'Retry capture' : 'Capture'}
                </Button>
            </>}
            {step === 'done' && <Button type="button" onClick={onClose}>{doneLabel}</Button>}
        </DialogFooter>
    </div>
}
