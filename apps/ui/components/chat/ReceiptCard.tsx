import { PANEL_CARD } from '@rerun/ui/primitives'
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function ReceiptCard({ icon: Glyph, title, meta, children }: { icon: ComponentType<{ className?: string }>; title: string; meta?: string; children: ReactNode }) {
    return (
        <div className={cn(PANEL_CARD, 'ml-auto w-full max-w-[85%]', 'overflow-hidden')}>
            <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
                <Glyph className="size-3.5 text-muted-foreground" />
                <span className="font-medium text-foreground">{title}</span>
                {meta && <span className="ml-auto text-muted-foreground">{meta}</span>}
            </div>
            <div className="divide-y divide-border">{children}</div>
        </div>
    )
}
