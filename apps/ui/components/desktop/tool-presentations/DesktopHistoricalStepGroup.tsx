'use client'

import { useState } from 'react'
import { ChevronRightIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { historicalIdentityProps } from './identity'
import type { DesktopHistoricalGenericItem } from './plan'
import type { DesktopToolPresentationStatus } from './status'

const STATUS_LABEL: Record<DesktopToolPresentationStatus, string> = {
    pending: 'Pending',
    running: 'Running',
    succeeded: 'Succeeded',
    failed: 'Failed',
    cancelled: 'Cancelled',
    unknown: 'Unknown',
}

/**
 * Consecutive generic steps, with the original step-count copy plus the states a generic
 * row cannot show. Expansion is local. It does not rerun a tool. No coworker glyph: that
 * glyph belongs to the hosted step group.
 */
export function DesktopHistoricalStepGroup({ items }: { items: readonly DesktopHistoricalGenericItem[] }) {
    const [open, setOpen] = useState(false)
    if (items.length === 0) return null
    const running = items.find(item => item.status === 'running')
    const live = !!running
    const failed = items.filter(item => item.status === 'failed').length
    const cancelled = items.filter(item => item.status === 'cancelled').length
    const unknown = items.filter(item => item.status === 'unknown').length
    const pending = items.filter(item => item.status === 'pending').length
    const count = `${items.length} ${items.length > 1 ? 'steps' : 'step'}`
    const extras = [
        failed > 0 ? `${failed} failed` : null,
        cancelled > 0 ? `${cancelled} cancelled` : null,
        unknown > 0 ? `${unknown} unknown` : null,
        pending > 0 && !live ? `${pending} pending` : null,
    ].filter((item): item is string => !!item)
    const aria = extras.length > 0 ? `${count}, ${extras.join(', ')}` : count
    const identity = items[0].identity
    return (
        <div className="flex w-full flex-col" data-historical="group" {...historicalIdentityProps(identity, items[0].key)}>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <button
                    type="button"
                    aria-expanded={open}
                    aria-label={aria}
                    onClick={() => setOpen(value => !value)}
                    className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 pr-2 pl-2 transition-colors hover:bg-muted/70"
                >
                    <span className="tabular-nums">{live ? items.length : count}</span>
                    {failed > 0 && <span className="text-red-500">{failed} failed</span>}
                    {cancelled > 0 && <span>{cancelled} cancelled</span>}
                    {unknown > 0 && <span>{unknown} unknown</span>}
                    {pending > 0 && !live && <span>{pending} pending</span>}
                    <ChevronRightIcon className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
                </button>
            </div>
            {open && (
                <div className="mt-1">
                    {items.map(item => (
                        <div key={item.key} className="px-1.5 py-1 text-xs" data-status={item.status} data-owner={item.identity.ownerId ?? ''} data-workspace={item.identity.workspaceId ?? ''} data-run={item.identity.runId ?? ''}>
                            <p className="truncate font-medium">{item.label}</p>
                            <p className="text-muted-foreground">{STATUS_LABEL[item.status]}</p>
                            {item.detail && <p className="mt-0.5 whitespace-pre-wrap break-all text-muted-foreground">{item.detail}</p>}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
