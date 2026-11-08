'use client'
import { Button } from '@/components/ui/button'
import { SourceAvatar } from '@/components/connections/SourceBits'
import { Badge } from '@rerun/ui/primitives'
import { ChevronLeftIcon } from '@/lib/icons'
import { apiCredentialStatus } from '@/lib/desktop/api-connections/presentation'
import type { DesktopApiConnectionView } from '@rerun/contracts'
import type { ReactNode } from 'react'

export function ApiConnectionStatus({ connection }: { connection: DesktopApiConnectionView }) {
    return <Badge size="xs" tone={connection.connected && !connection.credentialRejected ? 'green' : 'orange'} className="shrink-0">{apiCredentialStatus(connection)}</Badge>
}
export function ApiDetailHeader({ connection, onBack, children }: { connection: DesktopApiConnectionView; onBack(): void; children: ReactNode }) {
    return <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2.5">
        <Button type="button" aria-label="Back to AI providers" variant="ghost" size="icon-sm" onClick={onBack}><ChevronLeftIcon className="size-4" /></Button>
        <SourceAvatar provider={connection.provider} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col">{children}<span className="truncate text-[11px] text-muted-foreground">{connection.provider} API key</span></div>
        <ApiConnectionStatus connection={connection} />
    </div>
}
