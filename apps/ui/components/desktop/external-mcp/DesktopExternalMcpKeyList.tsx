'use client'

import type { ExternalMcpKeyView } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { BanIcon } from '@/lib/icons'
import { shortRelativeTime } from '@/lib/time'

export function DesktopExternalMcpKeyList({ keys, busy, pendingKeyIds = new Set<string>(), onRevoke }: { keys: ExternalMcpKeyView[]; busy: boolean; pendingKeyIds?: ReadonlySet<string>; onRevoke: (key: ExternalMcpKeyView) => void }) {
    return (
        <div className="min-w-0 overflow-hidden rounded-lg border border-border/60">
            {keys.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">No key yet. A key carries the whole workspace, so treat it like a password.</p>
            ) : (
                <div className="divide-y divide-border/60">
                    {keys.map(key => <Row key={key.keyId} apiKey={key} busy={busy} pending={pendingKeyIds.has(key.keyId)} onRevoke={onRevoke} />)}
                </div>
            )}
        </div>
    )
}

function Row({ apiKey, busy, pending, onRevoke }: { apiKey: ExternalMcpKeyView; busy: boolean; pending: boolean; onRevoke: (key: ExternalMcpKeyView) => void }) {
    const state = apiKey.status === 'revoked' ? 'Revoked' : apiKey.status === 'expired' ? 'Expired' : apiKey.lastUsedAt ? `Used ${shortRelativeTime(apiKey.lastUsedAt)}` : 'Never used'
    return (
        <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
            <div className="min-w-0 flex-1">
                <span className="block truncate text-sm">{apiKey.name}</span>
                <span className="block font-mono text-[11px] break-all text-muted-foreground">{apiKey.keyPrefix}…</span>
                <span className="block text-[11px] break-words text-muted-foreground">{apiKey.scopes.join(', ')}{apiKey.expiresAt ? ` · Expires ${shortRelativeTime(apiKey.expiresAt)}` : ''}</span>
            </div>
            <span className="shrink-0 text-[11px] text-muted-foreground">{pending ? 'Revoke unfinished' : state}</span>
            <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy || apiKey.status !== 'active'}
                onClick={() => onRevoke(apiKey)}
                title="Revoke this key"
                aria-label="Revoke this key"
                className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
            >
                <BanIcon className="size-4" />
            </Button>
        </div>
    )
}
