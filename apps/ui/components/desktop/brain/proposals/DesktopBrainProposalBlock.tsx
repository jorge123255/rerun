'use client'

import { BrainIcon } from '@/lib/icons'
import { Button, Icon } from '@rerun/ui/primitives'

// Same row as the hosted Brain proposal card. Review stays on this Mac's proposal panel.
// It does not open the hosted knowledge base.

export function DesktopBrainProposalBlock({ title, mode, onReview }: { title: string; mode: 'create' | 'edit'; onReview?: () => void }) {
    return (
        <div className="rounded-xl bg-muted/30 px-1.5 py-1.5">
            <div className="flex items-center gap-3 text-sm">
                <Icon size="sm" icon={BrainIcon} />
                <div className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{mode === 'create' ? `New Brain page: ${title}` : `Change to the Brain: ${title}`}</span>
                    <span className="block truncate text-xs text-muted-foreground">Proposed for review. Nothing changes until someone accepts it.</span>
                </div>
                {onReview && <Button size="xs" variant="ghost" onClick={onReview}>Review</Button>}
            </div>
        </div>
    )
}
