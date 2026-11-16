'use client'
import { Badge } from '@rerun/ui/primitives'
import type { DesktopRemoteSnapshot } from '@rerun/contracts'
import { PanelRow } from '@/components/ui/panel-row'
import { Button } from '@/components/ui/button'
import { CloudIcon, ServerIcon } from '@/lib/icons'

export function LocalMachineRow({ runtime }: { runtime: NonNullable<DesktopRemoteSnapshot['localRuntime']> }) {
    const connected = runtime.state === 'connected'
    return <PanelRow leading={<ServerIcon className="size-4 shrink-0 text-muted-foreground" />}
        title="This workspace's server"
        description={connected ? 'This Mac · Your coworkers run locally on this Mac.' : runtime.state === 'unknown' ? 'This Mac · Local runtime status is unavailable.' : 'This Mac · Not in use.'}
        meta={<Badge size="xs" fill="soft" tone={connected ? 'green' : 'neutral'} glow={false}>{connected ? 'Connected' : runtime.state === 'unknown' ? 'Unknown' : 'Not connected'}</Badge>} />
}

/**
 * The owner's hosted workspace. It is not a server this Mac pairs with: it opens in its own
 * window, signed in separately, and shares nothing with the local workspace.
 */
export function RerunCloudRow({ onOpen }: { onOpen: () => void }) {
    return <PanelRow leading={<CloudIcon className="size-4 shrink-0 text-muted-foreground" />}
        title="Rerun Cloud"
        description="Your hosted workspace. Opens in its own window with its own sign-in; nothing is shared with this Mac's workspace."
        meta={<Button type="button" size="sm" variant="outline" onClick={onOpen}>Open</Button>} />
}
