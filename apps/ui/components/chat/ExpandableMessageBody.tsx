'use client'

import { ChevronDownIcon, ChevronUpIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Badge } from '@rerun/ui/primitives'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

const COLLAPSED_HEIGHT = 384

/** Share the web message layout while letting each client render its own links and mentions. */
export function ExpandableMessageBody({ children, forceExpanded = false, showMore = 'Show more', showLess = 'Show less' }: {
    children: ReactNode
    forceExpanded?: boolean
    showMore?: string
    showLess?: string
}) {
    const bodyId = useId()
    const contentRef = useRef<HTMLDivElement>(null)
    const [contentHeight, setContentHeight] = useState(0)
    const [expanded, setExpanded] = useState(false)

    useEffect(() => {
        const element = contentRef.current
        if (!element) return
        const measure = () => setContentHeight(element.offsetHeight)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
    }, [])

    const overflows = contentHeight > COLLAPSED_HEIGHT
    const capped = overflows && !forceExpanded
    const collapsed = capped && !expanded

    return (
        <div className="flex flex-col">
            <div className={cn(
                !forceExpanded && 'overflow-hidden transition-[max-height] duration-300 ease-out motion-reduce:transition-none',
                collapsed && '[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]',
            )} style={{ maxHeight: capped ? (collapsed ? COLLAPSED_HEIGHT : contentHeight) : undefined }}>
                <div id={bodyId} ref={contentRef}>{children}</div>
            </div>
            {capped && (
                <button type="button" aria-controls={bodyId} aria-expanded={expanded}
                    onClick={() => setExpanded(open => !open)}
                    className="mt-2 self-center opacity-80 transition-opacity hover:opacity-100">
                    <Badge tone="white" size="xs" className="[--badge-fg:#fff]! [--badge-soft:rgba(255,255,255,0.12)]!"
                        trailing={expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}>
                        {expanded ? showLess : showMore}
                    </Badge>
                </button>
            )}
        </div>
    )
}
