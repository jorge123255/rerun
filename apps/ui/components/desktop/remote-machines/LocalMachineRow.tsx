'use client'
import { Badge } from '@rerun/ui/primitives'
import type { DesktopRemoteSnapshot } from '@rerun/contracts'
import { PanelRow } from '@/components/ui/panel-row'
import { ServerIcon } from '@/lib/icons'

export function LocalMachineRow({ runtime }: { runtime: NonNullable<DesktopRemoteSnapshot['localRuntime']> }) {
    const connected = runtime.state === 'connected'
    return <PanelRow leading={<ServerIcon className="size-4 shrink-0 text-muted-foreground" />}
        title="This workspace's server"
        description={connected ? 'This Mac · Your coworkers run locally on this Mac.' : runtime.state === 'unknown' ? 'This Mac · Local runtime status is unavailable.' : 'This Mac · Not in use.'}
        meta={<Badge size="xs" fill="soft" tone={connected ? 'green' : 'neutral'} glow={false}>{connected ? 'Connected' : runtime.state === 'unknown' ? 'Unknown' : 'Not connected'}</Badge>} />
}
