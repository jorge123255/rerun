'use client'

import { StepDots } from '@rerun/ui/chat'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { Button } from '@/components/ui/button'
import { TooltipDisabledReason } from '@/components/ui/tooltip'
import { ArrowRight } from '@/lib/icons'
import type { DesktopForemanIntakeController } from '@/lib/desktop/foreman-intake'
import { cn } from '@/lib/utils'
import { DesktopAnimatedHeight } from './DesktopAnimatedHeight'
import { DesktopIntakeChoiceStep } from './DesktopIntakeChoiceStep'
import { DesktopIntakeCompanyStep } from './DesktopIntakeCompanyStep'
import { DesktopIntakeIndustryStep } from './DesktopIntakeIndustryStep'
import { DesktopIntakeTextStep } from './DesktopIntakeTextStep'

const STEP_MOTION = {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -6 },
    transition: { duration: 0.18, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] },
}

/**
 * Original ForemanIntakeCard: takes the composer slot, same stepper and Skip/Next footer.
 * Compact / short-window: max-sm button sizing; role list ScrollFade max-h shrinks on small screens.
 */
export function DesktopForemanIntakeCard({
    intake,
    autoFocus = true,
    className,
}: {
    intake: DesktopForemanIntakeController
    autoFocus?: boolean
    className?: string
}) {
    const {
        step,
        draft,
        index,
        steps,
        answered,
        reachable,
        canAdvance,
        submitting,
        error,
        siteRead,
        finished,
        restored,
        locked,
        quitting,
        canRetry,
        saveFailed,
        conflicted,
        retryRestore,
        retrySave,
        reloadSaved,
        set,
        chooseIndustry,
        chooseRole,
        skipWebsite,
        goTo,
        next,
        roles,
    } = intake
    const still = useReducedMotion()
    const busy = submitting || finished || quitting
    const fieldsDisabled = busy || locked
    const skippable = step === 'company' && !draft.companyUrl.trim()
    const motionProps = still
        ? { initial: false, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0 } }
        : STEP_MOTION

    if (finished) return null
    if (!restored) return (
        <div data-foreman-intake className={cn('mb-2 space-y-3 rounded-lg border border-border bg-muted/30 p-3', className)}>
            <p role={error ? 'alert' : 'status'} className="text-sm">{error ?? 'Restoring your answers…'}</p>
            {error && <Button size="sm" disabled={quitting} onClick={retryRestore}>Try again</Button>}
        </div>
    )

    return (
        <div data-foreman-intake className={cn('relative mb-2 flex max-h-[min(70vh,32rem)] flex-col gap-3 overflow-hidden rounded-lg border border-border bg-muted/30 p-3 max-sm:max-h-[min(78vh,28rem)]', className)}>
            <div className="min-h-0 overflow-y-auto overscroll-contain">
            <DesktopAnimatedHeight>
                <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div key={step} {...motionProps}>
                        {step === 'company' && (
                            <DesktopIntakeCompanyStep draft={draft} siteRead={siteRead} disabled={fieldsDisabled} autoFocus={autoFocus} onChange={set} onEnter={next} />
                        )}
                        {step === 'industry' && (
                            <DesktopIntakeIndustryStep draft={draft} disabled={fieldsDisabled} autoFocus={autoFocus} onChange={set} onChoose={chooseIndustry} onEnter={next} />
                        )}
                        {step === 'role' && (
                            <DesktopIntakeChoiceStep
                                label="Your role"
                                options={roles}
                                value={draft.position}
                                placeholder="Head of Growth"
                                disabled={fieldsDisabled}
                                autoFocus={autoFocus}
                                onChange={position => set({ position })}
                                onChoose={chooseRole}
                                onEnter={next}
                            />
                        )}
                        {step === 'name' && (
                            <DesktopIntakeTextStep
                                label="First name"
                                value={draft.firstName}
                                placeholder="John"
                                disabled={fieldsDisabled}
                                autoFocus={autoFocus}
                                onChange={firstName => set({ firstName })}
                                onEnter={next}
                            />
                        )}
                    </motion.div>
                </AnimatePresence>
            </DesktopAnimatedHeight>
            </div>

            {error && <p role="alert" className="shrink-0 px-1 text-xs text-destructive">{error}</p>}
            {saveFailed && <Button size="sm" variant="outline" className="shrink-0" disabled={busy || locked} onClick={conflicted ? reloadSaved : retrySave}>{conflicted ? 'Reload saved answers' : 'Retry saving'}</Button>}

            <div className="flex shrink-0 items-center justify-between gap-2 px-1">
                <StepDots count={steps.length} current={index} answered={answered} reachable={reachable} onSelect={goTo} disabled={fieldsDisabled} />
                {skippable && !canRetry ? (
                    <Button size="sm" disabled={fieldsDisabled} onClick={skipWebsite} data-intake="skip" className="max-sm:h-9 max-sm:px-3 max-sm:text-sm">
                        Skip
                    </Button>
                ) : (
                    <TooltipDisabledReason reason={!busy && !canAdvance && !canRetry ? 'Answer this step to continue' : undefined}>
                        <Button size="sm" disabled={busy || !canRetry && !canAdvance} onClick={next} data-intake="next" className="max-sm:h-9 max-sm:px-3 max-sm:text-sm">
                            {canRetry ? 'Retry' : 'Next'}
                            <ArrowRight data-icon="inline-end" className="size-4" />
                        </Button>
                    </TooltipDisabledReason>
                )}
            </div>
        </div>
    )
}
