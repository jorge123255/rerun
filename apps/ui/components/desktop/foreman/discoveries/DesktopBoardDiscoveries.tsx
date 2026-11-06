'use client'

import { AnimatePresence, motion } from 'motion/react'
import { usePrefersReducedMotion } from '@rerun/ui/iso-grid'
import {
    projectDiscoveriesOverlay,
    type DesktopDiscoveriesState,
    type DesktopDiscoveryEntry,
} from '@/lib/desktop/foreman-client'
import { DesktopDiscoveryCard, DesktopDiscoveryUnavailableCard, DISCOVERY_CARD_CLASS } from './DesktopDiscoveryCard'
import { DesktopDiscoveryStack } from './DesktopDiscoveryStack'
import { DesktopDiscoveryStatusPill } from './DesktopDiscoveryStatusPill'
import { DesktopDiscoveryTeaser } from './DesktopDiscoveryTeaser'

export function DesktopBoardDiscoveries({
    state,
    domain,
    compact = false,
}: {
    state: DesktopDiscoveriesState
    domain: string
    compact?: boolean
}) {
    const still = usePrefersReducedMotion()
    const projected = projectDiscoveriesOverlay(state, domain)
    const sorted = projected.entries
    const cards = sorted.filter((entry): entry is Extract<DesktopDiscoveryEntry, { type: 'finding' }> => entry.type === 'finding')
    const flowing = sorted
    const digging = !state.ended && sorted.some(entry => entry.type === 'teaser')

    if (projected.empty && !projected.error) return null

    return (
        <div className="pointer-events-none absolute inset-0 z-10">
            <div className="absolute inset-x-0 top-4 flex flex-col items-center gap-2 px-4">
                {projected.error ? (
                    <div className={DISCOVERY_CARD_CLASS} role="alert">
                        <p className="text-xs text-destructive">{projected.error}</p>
                    </div>
                ) : (
                    <DesktopDiscoveryStatusPill name={projected.subject.name} found={cards.length} digging={digging || projected.loading} />
                )}
                {compact && (
                    <div className="w-full max-w-72">
                        <AnimatePresence mode="popLayout" initial={false}>
                            {flowing.at(-1) && (
                                <motion.div
                                    key={flowing.at(-1)!.id}
                                    initial={still ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.94 }}
                                    animate={{ opacity: 1, y: 0, scale: 1 }}
                                    exit={{ opacity: 0 }}
                                >
                                    <EntryView entry={flowing.at(-1)!} subject={projected.subject} />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}
            </div>
            {!compact && <DesktopDiscoveryStack entries={cards} className="absolute -bottom-2 -right-2 w-72" />}
        </div>
    )
}

function EntryView({
    entry,
    subject,
}: {
    entry: DesktopDiscoveryEntry
    subject: { name: string; domain: string }
}) {
    if (entry.type === 'teaser') return <DesktopDiscoveryTeaser source={entry.source} subject={subject} />
    if (entry.type === 'finding') return <DesktopDiscoveryCard finding={entry.finding} />
    return <DesktopDiscoveryUnavailableCard source={entry.source} />
}
