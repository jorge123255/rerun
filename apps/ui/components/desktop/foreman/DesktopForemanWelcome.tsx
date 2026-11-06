'use client'

import { motion, useReducedMotion } from 'motion/react'
import { Orb, WELCOME_ORB_SIZE } from '@rerun/ui/foreman'
import { Shimmer } from '@/components/ai-elements/shimmer'

const EASE = [0.22, 1, 0.36, 1] as const

export function DesktopForemanWelcome({
    thinking,
    title = 'Hey, ready to hand off your first task?',
    subtitle,
}: {
    thinking?: boolean
    title?: string
    subtitle?: string
}) {
    const reducedMotion = useReducedMotion()
    const enter = (delay: number) => ({
        initial: reducedMotion ? { opacity: 0 } : { opacity: 0, y: 10, filter: 'blur(8px)' },
        animate: reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)' },
        transition: reducedMotion ? { duration: 0 } : { duration: 0.38, ease: EASE, delay },
    })

    return (
        <motion.div
            className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 p-8 text-center"
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            transition={reducedMotion ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' }}
        >
            <motion.div {...enter(0)}>
                <Orb size={WELCOME_ORB_SIZE} state={thinking ? 'thinking' : 'idle'} />
            </motion.div>
            <motion.div className="space-y-1" {...enter(0.12)}>
                <h3 className="text-sm font-medium">{title}</h3>
                {subtitle ? <p className="text-balance text-sm text-muted-foreground">{subtitle}</p> : <Shimmer className="text-sm">Getting your workspace ready...</Shimmer>}
            </motion.div>
        </motion.div>
    )
}
