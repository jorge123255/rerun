'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// The room the chat leaves for the column while it sits beside it.
export const DESKTOP_DETAILS_ROOM = 'pr-[26rem]'

/**
 * The right column of the Simple view, beside whoever holds the middle (upstream #315's
 * DetailsColumn, in the Mac's frame): a coworker's card, or the Chief of Staff's panel. On a window
 * at least 1280 wide it is a column of its own, flush with the right edge, and the chat stays in use
 * beside it; narrower, it lies over the chat. Its parent is the positioned frame it fills.
 */
export function DesktopDetailsColumn({ label, open, beside, bare = false, children }: {
    label: string
    open: boolean
    // In its own column beside the chat rather than over it.
    beside: boolean
    // The older card of a chat opened without a coworker's overview: a short panel under the header.
    bare?: boolean
    children: ReactNode
}) {
    return <section aria-label={label} hidden={!open} data-card-beside={beside || undefined} className={cn(
        !open ? 'hidden'
            : bare ? 'absolute inset-x-3 top-14 z-40 rounded-2xl border border-border bg-background p-4 shadow-xl'
                : beside ? 'absolute inset-y-0 right-0 z-40 flex min-h-0 w-[26rem] flex-col overflow-auto border-l border-border bg-background'
                    : 'absolute inset-x-3 top-14 bottom-3 z-40 flex min-h-0 flex-col overflow-auto rounded-2xl border border-border bg-background shadow-xl')}>
        {children}
    </section>
}
