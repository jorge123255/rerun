'use client'

import { Badge, Icon, PANEL_CARD } from '@rerun/ui/primitives'
import { PlugIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { historicalIdentityProps } from './identity'
import type { DesktopHistoricalIdentity } from './status'

/**
 * Frozen mcp_register / mcp_login outcome. No status lookup, no Connect, no OAuth.
 * A saved card has no live badge: the hosted badge refetches and can say Connected.
 */
export function DesktopHistoricalMcpOutcome({ name, host, outcome, failure, identity, toolCallId }: {
    name: string
    host: string | null
    outcome: 'saved' | 'failed'
    failure?: string
    identity: DesktopHistoricalIdentity
    toolCallId: string
}) {
    const props = { ...historicalIdentityProps(identity, toolCallId), 'data-historical': 'mcp', 'data-status': 'succeeded', 'data-mcp-outcome': outcome }
    if (outcome === 'failed') {
        return (
            <div className={cn(PANEL_CARD, 'flex items-center gap-3 px-3 py-2.5')} {...props}>
                <Icon icon={PlugIcon} size="sm" />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">Couldn&apos;t connect {name}</p>
                    {failure && <p className="line-clamp-2 text-xs text-muted-foreground">{failure}</p>}
                </div>
                <Badge size="xs" tone="red" glow={false}>Not added</Badge>
            </div>
        )
    }
    return (
        <div className={cn(PANEL_CARD, 'flex items-center gap-3 px-3 py-2.5')} {...props}>
            <Icon icon={PlugIcon} size="sm" />
            <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{name} added</p>
                <p className="truncate text-xs text-muted-foreground">{host ? `Custom MCP server · ${host}` : 'Custom MCP server'}</p>
            </div>
        </div>
    )
}
