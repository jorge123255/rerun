'use client'

import { useStepper } from '@rerun/ui/steps'
import { useCallback, useMemo, useState } from 'react'
import { DesktopCreateTemplateTitleStep } from './DesktopCreateTemplateTitleStep'
import { SplitDialogContent } from '@/components/dialogs/SplitDialogContent'
import { StepDialogHeader } from '@/components/dialogs/StepDialogHeader'
import { Dialog } from '@/components/ui/dialog'
import type { DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import { createDesktopCaptureActions } from './capture-actions'
import { DESKTOP_CAPTURE_STEP_COPY, DesktopCaptureStepPanel } from './DesktopCaptureStepPanel'
import { DesktopCaptureProgressPanel } from './DesktopCaptureProgressPanel'
import type { DesktopTemplateDraft } from './types'
import { useDesktopCaptureFlow, type DesktopCaptureStep } from './useDesktopCaptureFlow'

const STEPS = ['title', 'select', 'review', 'done'] as const

export function DesktopCreateTemplateDialog({ open, client, onOpenChange, onDone }: {
    open: boolean
    client: DesktopTemplatesClient
    onOpenChange: (open: boolean) => void
    onDone: (template: DesktopTemplateDraft) => void
}) {
    const [draft, setDraft] = useState<DesktopTemplateDraft | null>(null)
    const [createError, setCreateError] = useState<string | null>(null)
    const stepper = useStepper(STEPS.length)
    const onRevision = useCallback((revision: string) => setDraft(current => current ? { ...current, revision } : current), [])
    const actions = useMemo(() => createDesktopCaptureActions(client, draft, onRevision), [client, draft, onRevision])
    // Keep the draft across a close, but read sources only when its picker is actually open.
    const flow = useDesktopCaptureFlow(actions, open && draft !== null)
    const step = STEPS[stepper.index]

    function close() {
        if (step === 'done' && draft) {
            onDone(draft)
            setDraft(null)
            setCreateError(null)
            flow.reset()
            stepper.reset()
        }
        onOpenChange(false)
    }

    return <Dialog open={open} onOpenChange={next => next ? onOpenChange(true) : close()}>
        <SplitDialogContent aside={<DesktopCaptureProgressPanel step={step} />}>
            <div className="flex min-h-0 flex-col p-6">
                <StepDialogHeader
                    count={STEPS.length}
                    index={stepper.index}
                    direction={stepper.direction}
                    title={step === 'title' ? 'New template' : DESKTOP_CAPTURE_STEP_COPY[step].title}
                    description={step === 'title' ? 'Save a private local template from existing coworkers.' : DESKTOP_CAPTURE_STEP_COPY[step].description}
                />
                {step === 'title' ? <>
                    <DesktopCreateTemplateTitleStep
                        onCancel={close}
                        onCreate={async title => {
                            setCreateError(null)
                            try {
                                const created = await client.createDraft(title)
                                setDraft(created)
                                stepper.goTo(1)
                            } catch (error) {
                                setCreateError(error instanceof Error ? error.message : 'The draft could not be saved. Retry the same title.')
                            }
                        }}
                    />
                    {createError && <p role="alert" className="mt-3 text-sm text-destructive">{createError}</p>}
                </> : <DesktopCaptureStepPanel
                    flow={flow}
                    step={step as DesktopCaptureStep}
                    direction={stepper.direction}
                    onStepChange={next => stepper.goTo(STEPS.indexOf(next))}
                    onClose={close}
                    doneLabel="Open template"
                />}
            </div>
        </SplitDialogContent>
    </Dialog>
}
