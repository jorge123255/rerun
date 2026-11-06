'use client'

import { motion, useReducedMotion } from 'motion/react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

const HEIGHT_TRANSITION = { duration: 0.28, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] }

export function DesktopAnimatedHeight({ children, className }: { children: ReactNode; className?: string }) {
    const inner = useRef<HTMLDivElement>(null)
    const [height, setHeight] = useState<number | null>(null)
    const still = useReducedMotion()

    useLayoutEffect(() => {
        const element = inner.current
        if (!element) return
        const observer = new ResizeObserver(() => setHeight(element.offsetHeight))
        observer.observe(element)
        setHeight(element.offsetHeight)
        return () => observer.disconnect()
    }, [])

    return (
        <motion.div
            animate={height === null || still ? undefined : { height }}
            initial={false}
            transition={still ? { duration: 0 } : HEIGHT_TRANSITION}
            className={cn('-m-1', className)}
            style={{ overflow: 'hidden', height: still && height !== null ? height : undefined }}
        >
            <div ref={inner} className="p-1">
                {children}
            </div>
        </motion.div>
    )
}
