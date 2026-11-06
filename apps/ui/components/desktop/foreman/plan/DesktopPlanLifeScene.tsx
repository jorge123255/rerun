'use client'

import { TextShimmer } from '@rerun/ui'
import { IsoGrid, agentTileStyle } from '@rerun/ui/iso-grid'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { CircleCheckIcon, InboxIcon, Loader2Icon, type LucideIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopPlanBeats, DesktopPlanGroupView } from '@/lib/desktop/foreman-client'
import { desktopPlanCardScene } from './plan-scene'

type PlanLifeStage = 'rest' | 'trigger' | 'working' | 'delivered'
type AgentStatus = Parameters<typeof agentTileStyle>[0]
type PlanLifeBeat = { hold: number; stage: PlanLifeStage; status: AgentStatus; line: string | null }

const REST_MS = 2800
const STAGE_LOOK: Record<Exclude<PlanLifeStage, 'rest'>, { icon: LucideIcon; className: string }> = {
    trigger: { icon: InboxIcon, className: 'text-muted-foreground' },
    working: { icon: Loader2Icon, className: 'text-amber-500' },
    delivered: { icon: CircleCheckIcon, className: 'text-emerald-500' },
}

function planLifeBeats({ trigger, working, delivered }: DesktopPlanBeats): PlanLifeBeat[] {
    return [
        { hold: REST_MS, stage: 'rest', status: 'idle', line: null },
        { hold: 3200, stage: 'trigger', status: 'idle', line: trigger },
        { hold: 4600, stage: 'working', status: 'working', line: working },
        { hold: 4200, stage: 'delivered', status: 'idle', line: delivered },
    ]
}

function ActivityLine({ beat, tick }: { beat: PlanLifeBeat; tick: number }) {
    const look = beat.stage === 'rest' ? null : STAGE_LOOK[beat.stage]
    return (
        <div className="flex h-9 items-center justify-center border-t border-border/60 px-3 text-xs">
            <AnimatePresence mode="wait">
                {look && beat.line ? (
                    <motion.span
                        key={tick}
                        className={cn('flex min-w-0 items-center gap-1.5', look.className)}
                        initial={{ opacity: 0, y: 6, filter: 'blur(3px)' }}
                        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                        exit={{ opacity: 0, y: -6, filter: 'blur(3px)' }}
                        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                    >
                        <look.icon className={cn('size-3.5 shrink-0', beat.stage === 'working' && 'animate-spin')} />
                        <span className="truncate">{beat.stage === 'working' ? <TextShimmer>{beat.line}</TextShimmer> : beat.line}</span>
                    </motion.span>
                ) : (
                    <motion.span key="rest" className="text-muted-foreground/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.28 }}>
                        Standing by
                    </motion.span>
                )}
            </AnimatePresence>
        </div>
    )
}

export function DesktopPlanLifeScene({
    group,
    script,
    waiting,
}: {
    group: DesktopPlanGroupView
    script: DesktopPlanBeats | null
    waiting: boolean
}) {
    const beats = useMemo(() => (script ? planLifeBeats(script) : null), [script])
    const [tick, setTick] = useState(0)
    useEffect(() => {
        if (!beats || waiting) return
        const hold = beats[tick % beats.length]?.hold ?? REST_MS
        const timer = setTimeout(() => setTick(current => current + 1), hold)
        return () => clearTimeout(timer)
    }, [beats, tick, waiting])
    const beat = beats ? beats[tick % beats.length] : { hold: REST_MS, stage: 'rest' as const, status: 'idle' as const, line: null }
    const animated = !waiting && !!script
    const scene = useMemo(() => desktopPlanCardScene(group, { animated }), [group, animated])
    const name = group.items[0]?.name ?? 'Coworker'
    const tiles = useMemo(
        () => scene.tiles.map((tile, rank) => (rank === 0 ? { ...tile, style: agentTileStyle(beat.status, name) } : tile)),
        [scene, beat.status, name],
    )

    return (
        <div className="overflow-hidden rounded-lg bg-background/60">
            <div className="pointer-events-none relative h-44">
                <IsoGrid tiles={tiles} containers={scene.containers} selectedTileId={null} selectedContainerId={null} fitToContent mask={false} scrollGestures={false} className="absolute inset-0" />
            </div>
            {script && <ActivityLine beat={beat} tick={tick} />}
        </div>
    )
}
