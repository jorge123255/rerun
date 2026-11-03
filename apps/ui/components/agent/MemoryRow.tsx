import { PanelDeleteButton } from '@/components/ui/panel-editor'
import { PanelRow } from '@/components/ui/panel-row'
import type { EngineMemory } from '@/lib/engine/types'
import { Badge } from '@rerun/ui/primitives'

export function MemoryRow({ memory, onDelete }: { memory: EngineMemory; onDelete?: () => void }) {
    return (
        <PanelRow
            className="items-start gap-2"
            meta={
                <>
                    {memory.kind && (
                        <Badge size="xs" tone="neutral" glow={false} className="uppercase tracking-wider">
                            {memory.kind}
                        </Badge>
                    )}
                    {memory.status === 'dormant' && (
                        <Badge size="xs" tone="neutral" glow={false} fill="outline" className="uppercase tracking-wider">
                            dormant
                        </Badge>
                    )}
                    {memory.strength !== undefined && <span className="text-[10px] tabular-nums text-muted-foreground">{Math.round(memory.strength * 100)}%</span>}
                    {(memory.tags ?? []).map(t => (
                        <span key={t} className="text-[10px] text-muted-foreground">#{t}</span>
                    ))}
                </>
            }
            actions={
                onDelete && (
                    <PanelDeleteButton
                        label="Delete memory"
                        size="icon-xs"
                        onClick={onDelete}
                        confirmTitle="Delete this memory?"
                        confirmDescription="The coworker forgets it for good. This cannot be undone."
                        className="opacity-0 transition-opacity group-hover:opacity-100"
                    />
                )
            }
        >
            <p className="whitespace-pre-wrap text-sm">{memory.content}</p>
        </PanelRow>
    )
}
