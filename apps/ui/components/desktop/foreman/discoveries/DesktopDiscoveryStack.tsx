'use client'

import { AnimatePresence, motion } from 'motion/react'
import { usePrefersReducedMotion } from '@rerun/ui/iso-grid'
import type { DesktopDiscoveryEntry } from '@/lib/desktop/foreman-client'
import { cn } from '@/lib/utils'
import { DesktopDiscoveryCard } from './DesktopDiscoveryCard'

export function DesktopDiscoveryStack({
    entries,
    className,
}: {
    entries: Extract<DesktopDiscoveryEntry, { type: 'finding' }>[]
    className?: string
}) {
    const still = usePrefersReducedMotion()
    const visible = entries.slice(-4)
    return (
        <div className={cn('flex flex-col gap-2', className)}>
            <AnimatePresence initial={false}>
                {visible.map((entry, index) => (
                    <motion.div
                        key={entry.id}
                        initial={still ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={still ? { duration: 0.15 } : { type: 'spring', stiffness: 260, damping: 24 }}
                        style={{ zIndex: index + 1 }}
                    >
                        <DesktopDiscoveryCard finding={entry.finding} still={!!still} />
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    )
}
