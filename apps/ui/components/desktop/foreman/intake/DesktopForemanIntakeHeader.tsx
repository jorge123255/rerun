'use client'

import { Orb, WELCOME_ORB_SIZE } from '@rerun/ui/foreman'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import { INTAKE_COPY, type DesktopForemanIntakeController } from '@/lib/desktop/foreman-intake'

const EASE = [0.22, 1, 0.36, 1] as const

/** Original ForemanIntakeHeader: orb + question copy above the card; reduced-motion aware. */
export function DesktopForemanIntakeHeader({
    intake,
    arrivalTitle,
}: {
    intake: DesktopForemanIntakeController
    arrivalTitle?: string | null
}) {
    const still = useReducedMotion()
    const copy = INTAKE_COPY[intake.step]

    const enter = (delay: number) => ({
        initial: still ? { opacity: 0 } : { opacity: 0, y: 10, filter: 'blur(8px)' },
        animate: still ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)' },
        transition: still ? { duration: 0 } : { duration: 0.38, ease: EASE, delay },
    })

    if (intake.finished || !intake.restored) return null

    return (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center justify-end gap-5 px-8 pb-6 text-center max-sm:gap-3 max-sm:px-4 max-sm:pb-4">
            <motion.div {...enter(0)}>
                <Orb size={WELCOME_ORB_SIZE} state={intake.submitting || intake.deciding ? 'thinking' : 'listening'} />
            </motion.div>

            {arrivalTitle && (
                <motion.p {...enter(0.04)} className="text-muted-foreground text-xs">
                    Setting up <span className="text-foreground">{arrivalTitle}</span>
                </motion.p>
            )}

            <div className="grid min-h-[5.25rem] w-full max-w-[22rem] items-start max-sm:min-h-[4.5rem]">
                <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                        key={intake.step}
                        {...enter(0.08)}
                        exit={still ? { opacity: 0 } : { opacity: 0, y: -8, filter: 'blur(6px)' }}
                        className="col-start-1 row-start-1 space-y-1.5"
                    >
                        <h3 className="font-medium text-base">{copy.title}</h3>
                        <p className="text-muted-foreground text-sm">{copy.description}</p>
                    </motion.div>
                </AnimatePresence>
            </div>
        </div>
    )
}
