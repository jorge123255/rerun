'use client'

import { useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { Orb, PARKED_ORB_SIZE, PARKED_ORB_SIZE_MOBILE, type OrbActivity } from '@rerun/ui/foreman'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const CORNER_CLASSES = {
    'top-left': 'top-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))] left-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))]',
    'top-right': 'top-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))] right-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))]',
    'bottom-left': 'bottom-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))] left-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))]',
    'bottom-right': 'bottom-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))] right-[calc(var(--chrome-edge,12px)+var(--board-inset,0px))]',
} as const

export type DesktopForemanDockCorner = keyof typeof CORNER_CLASSES

/**
 * Parked Foreman orb. Opening/closing is deliberate via injected callbacks; the board stays visible.
 * Root mounts this beside DesktopBoard — this package does not mount centrally.
 */
export function DesktopForemanDock({
    open,
    onToggle,
    activity = 'idle',
    corner = 'bottom-right',
    mobile = false,
    label = 'Ask Rerun',
}: {
    open: boolean
    onToggle: () => void
    activity?: OrbActivity
    corner?: DesktopForemanDockCorner
    mobile?: boolean
    label?: string
}) {
    const reducedMotion = useReducedMotion()
    const [dragged, setDragged] = useState(false)
    const size = mobile ? PARKED_ORB_SIZE_MOBILE : PARKED_ORB_SIZE

    return (
        <div
            data-foreman-orb
            style={{ width: size, height: size }}
            className={cn('pointer-events-none fixed z-40', CORNER_CLASSES[corner])}
        >
            <div
                className={cn('relative block', !open && 'pointer-events-auto touch-none')}
                style={{
                    opacity: open ? 0 : 1,
                    transform: open ? 'scale(0.7)' : 'scale(1)',
                    transition: reducedMotion ? undefined : 'opacity 0.22s ease-out, transform 0.22s ease-out',
                }}
            >
                <TooltipLabeled side={corner.startsWith('bottom') ? 'top' : 'bottom'} hidden={open} label={label}>
                    <span className="block">
                        <Orb
                            size={size}
                            state={activity}
                            paused={open}
                            facing={corner.endsWith('left') ? 'right' : 'left'}
                            label={label}
                            onClick={
                                open
                                    ? undefined
                                    : () => {
                                          if (dragged) {
                                              setDragged(false)
                                              return
                                          }
                                          onToggle()
                                      }
                            }
                        />
                    </span>
                </TooltipLabeled>
            </div>
        </div>
    )
}
