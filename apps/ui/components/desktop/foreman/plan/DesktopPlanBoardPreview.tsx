'use client'

import { IsoGrid } from '@rerun/ui/iso-grid'
import { useEffect, useMemo, useState } from 'react'
import { usePrefersReducedMotion } from '@rerun/ui/iso-grid'
import type { SpaceRect } from '@/lib/board/space-layout'
import type { DesktopShownPlanView } from '@/lib/desktop/foreman-client'
import { desktopPlanScene, settledDesktopPlanScene } from './plan-scene'

export function DesktopPlanBoardPreview({
    plan,
    built = [],
    className,
}: {
    plan: DesktopShownPlanView
    built?: SpaceRect[]
    className?: string
}) {
    const reduced = usePrefersReducedMotion()
    const scene = useMemo(() => desktopPlanScene(plan, { animated: !reduced, built }), [plan, built, reduced])
    const [settled, setSettled] = useState(reduced || scene.landedAt === 0)
    useEffect(() => {
        setSettled(reduced || scene.landedAt === 0)
        if (reduced || scene.landedAt === 0) return
        const timer = setTimeout(() => setSettled(true), scene.landedAt)
        return () => clearTimeout(timer)
    }, [scene, reduced])
    const drawn = settled ? settledDesktopPlanScene(scene) : scene
    return (
        <div className={className} aria-hidden>
            <IsoGrid
                tiles={drawn.tiles}
                containers={drawn.containers}
                selectedTileId={null}
                selectedContainerId={null}
                fitToContent
                mask={false}
                scrollGestures={false}
                className="absolute inset-0"
            />
        </div>
    )
}
