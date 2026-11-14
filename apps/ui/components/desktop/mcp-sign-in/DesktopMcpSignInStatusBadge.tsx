'use client'

import { Badge } from '@rerun/ui/primitives'
import { Skeleton } from '@/components/ui/skeleton'
import type { DesktopMcpSignInOAuthView, DesktopMcpSignInView } from '../../../../../packages/contracts/src/desktop-mcp-sign-in'
import { useDesktopLocale } from '../DesktopLocale'

export function DesktopMcpSignInStatusBadge({ request, oauth, loading }: { request: DesktopMcpSignInView; oauth?: DesktopMcpSignInOAuthView; loading?: boolean }) {
    const { t } = useDesktopLocale()
    if (loading) return <Skeleton className="h-4 w-16 rounded-full" />
    if (oauth?.state === 'connected' || request.status === 'connected') return <Badge size="xs" tone="green" glow={false}>{t('mcpSignIn.connected')}</Badge>
    if (oauth?.state === 'error' || oauth?.state === 'unsupported' || request.status === 'error') return <Badge size="xs" tone="red" glow={false}>{t('mcpSignIn.unreachable')}</Badge>
    if (request.status === 'declined') return <Badge size="xs" tone="neutral" glow={false}>{t('mcpSignIn.notNow')}</Badge>
    return <Badge size="xs" tone="orange" glow={false}>{t('mcpSignIn.needsAuth')}</Badge>
}
