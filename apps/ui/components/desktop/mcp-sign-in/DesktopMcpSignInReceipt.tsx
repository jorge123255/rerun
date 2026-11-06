'use client'

import { Badge, PANEL_CARD } from '@rerun/ui/primitives'
import { PlugIcon, XIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopMcpSignInView } from '../../../../../packages/contracts/src/desktop-mcp-sign-in'

export function DesktopMcpSignInReceipt({ request, className }: { request: DesktopMcpSignInView; className?: string }) {
    const receipt = request.receipt
    if (!receipt) return null
    if (receipt.outcome === 'declined') return <p className={cn('ml-auto flex items-center gap-1.5 text-xs text-muted-foreground', className)}><XIcon className="size-3" />You skipped signing in</p>
    return <div className={cn(PANEL_CARD, 'ml-auto flex w-full max-w-[85%] items-center gap-3 px-3 py-2.5', className)} data-mcp-sign-in-receipt={request.requestId}>
        <PlugIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{request.source.server.displayName}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">{request.source.server.name}</p>
        </div>
        <Badge size="xs" tone="green" glow={false}>Connected</Badge>
    </div>
}

export function DesktopMcpSignInSummary({ name }: { name?: string }) {
    if (!name) return <p className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"><XIcon className="size-3" />You skipped signing in</p>
    return <div className={cn(PANEL_CARD, 'ml-auto flex w-full max-w-[85%] items-center gap-3 px-3 py-2.5')}>
        <PlugIcon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span><Badge size="xs" tone="green" glow={false}>Connected</Badge>
    </div>
}
