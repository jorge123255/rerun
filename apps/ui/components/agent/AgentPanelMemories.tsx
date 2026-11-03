'use client'

import { clearMemoriesAction, createMemoryAction, deleteMemoryAction, listMemoriesAction, recallMemoriesAction } from '@/app/api/_actions/agent.actions'
import { ClearMemoriesDialog } from '@/components/dialogs/ClearMemoriesDialog'
import { MemoryRow } from './MemoryRow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { EngineMemory } from '@/lib/engine/types'
import { BrainIcon, PlusIcon, SearchIcon, Trash2Icon, XIcon } from '@/lib/icons'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelList, PanelListHeader, PanelScroller } from '@/components/ui/panel-list'
import { SkeletonPanelRows } from '@/components/ui/skeleton'
import { useCallback, useEffect, useState } from 'react'

type AgentPanelMemoriesProps = {
    agentId: string
}

export function AgentPanelMemories({ agentId }: AgentPanelMemoriesProps) {
    const [memories, setMemories] = useState<EngineMemory[]>([])
    const [loading, setLoading] = useState(true)
    const [creating, setCreating] = useState(false)
    const [content, setContent] = useState('')
    const [kind, setKind] = useState('')
    const [tags, setTags] = useState('')
    const [saving, setSaving] = useState(false)

    const [query, setQuery] = useState('')
    const [recall, setRecall] = useState<EngineMemory[] | null>(null)
    const [searching, setSearching] = useState(false)
    const [confirmClear, setConfirmClear] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        setMemories(await listMemoriesAction(agentId))
        setLoading(false)
    }, [agentId])

    useEffect(() => {
        load()
    }, [load])

    const handleCreate = useCallback(async () => {
        if (!content.trim()) return
        setSaving(true)
        const result = await createMemoryAction(agentId, {
            content: content.trim(),
            kind: kind.trim() || undefined,
            tags: tags.trim() ? tags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
        })
        setSaving(false)
        if (result.success) {
            setContent('')
            setKind('')
            setTags('')
            setCreating(false)
            load()
        }
    }, [agentId, content, kind, tags, load])

    const handleSearch = useCallback(async () => {
        if (!query.trim()) {
            setRecall(null)
            return
        }
        setSearching(true)
        setRecall(await recallMemoriesAction(agentId, query.trim(), 5))
        setSearching(false)
    }, [agentId, query])

    const handleDelete = useCallback(async (memoryId: string) => {
        const result = await deleteMemoryAction(agentId, memoryId)
        if (result.success) {
            setMemories(prev => prev.filter(m => m.id !== memoryId))
            setRecall(prev => (prev ? prev.filter(m => m.id !== memoryId) : prev))
        }
    }, [agentId])

    const handleClearAll = useCallback(async () => {
        setConfirmClear(false)
        await clearMemoriesAction(agentId)
        setQuery('')
        setRecall(null)
        load()
    }, [agentId, load])

    const shown = recall ?? memories

    return (
        <div className="flex flex-col h-full">
            <PanelListHeader className="flex-col items-stretch gap-2">
                <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                        <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                        <Input
                            hideRequired
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleSearch()}
                            placeholder="Recall memories..."
                            className="h-8 pl-7 text-xs"
                        />
                        {recall !== null && (
                            <button onClick={() => { setQuery(''); setRecall(null) }} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                <XIcon className="size-3.5" />
                            </button>
                        )}
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setCreating(c => !c)}>
                        <PlusIcon className="size-3.5 mr-1" /> New
                    </Button>
                    {memories.length > 0 && (
                        <Button size="icon-sm" variant="destructive" onClick={() => setConfirmClear(true)} title="Clear all memories" aria-label="Clear all memories">
                            <Trash2Icon />
                        </Button>
                    )}
                </div>
                {recall !== null && <p className="text-[11px] text-muted-foreground">{searching ? 'Searching…' : `${recall.length} recalled for "${query}"`}</p>}
            </PanelListHeader>

            {creating && (
                <div className="flex flex-col gap-2 p-3 border-b border-border bg-muted/30">
                    <Textarea value={content} onChange={e => setContent(e.target.value)} placeholder="The user prefers concise answers." className="text-xs min-h-20" />
                    <div className="flex gap-2">
                        <Input hideRequired value={kind} onChange={e => setKind(e.target.value)} placeholder="kind (e.g. preference)" className="h-8 text-xs" />
                        <Input hideRequired value={tags} onChange={e => setTags(e.target.value)} placeholder="tags, comma,sep" className="h-8 text-xs" />
                    </div>
                    <Button size="sm" loading={saving} onClick={handleCreate} disabled={!content.trim()}>
                        Save memory
                    </Button>
                </div>
            )}

            {loading ? (
                <SkeletonPanelRows rows={5} badge />
            ) : shown.length === 0 ? (
                <EmptyState
                    icon={BrainIcon}
                    title={recall !== null ? 'No matches' : 'No memories yet'}
                    description={recall !== null ? undefined : 'Your coworker saves long-term facts about you and its work here, so it keeps context across conversations.'}
                    action={
                        recall === null ? (
                            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
                                <PlusIcon className="size-3.5 mr-1" /> Add memory
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <PanelScroller>
                    <PanelList>
                        {shown.map((m, i) => (
                            <MemoryRow key={m.id ?? i} memory={m} onDelete={m.id ? () => handleDelete(m.id!) : undefined} />
                        ))}
                    </PanelList>
                </PanelScroller>
            )}

            <ClearMemoriesDialog open={confirmClear} onOpenChange={setConfirmClear} onConfirm={handleClearAll} />
        </div>
    )
}
