'use client'

import { Badge } from '@rerun/ui/primitives'
import { Skeleton } from '@/components/ui/skeleton'
import type { DesktopMcpSignInOAuthView, DesktopMcpSignInView } from '../../../../../../packages/contracts/src/desktop-mcp-sign-in'

export function DesktopMcpSignInStatusBadge({ request, oauth, loading }: { request: DesktopMcpSignInView; oauth?: DesktopMcpSignInOAuthView; loading?: boolean }) {
    if (loading) return <Skeleton className="h-4 w-16 rounded-full" />
    if (oauth?.state === 'connected' || request.status === 'connected') return <Badge size="xs" tone="green" glow={false}>Connected</Badge>
    if (oauth?.state === 'error' || oauth?.state === 'unsupported' || request.status === 'error') return <Badge size="xs" tone="red" glow={false}>Unreachable</Badge>
    if (request.status === 'declined') return <Badge size="xs" tone="neutral" glow={false}>Not now</Badge>
    return <Badge size="xs" tone="orange" glow={false}>Sign-in needed</Badge>
}
