'use client'

import { useEffect, useState } from 'react'
import { memoriesListSchema } from '@rerun/contracts'
import { MemoryRow } from '@/components/agent/MemoryRow'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { PanelList } from '@/components/ui/panel-list'
import { BrainIcon } from '@/lib/icons'
import type { EngineMemory } from '@/lib/engine/types'
import type { DesktopAgentView } from './DesktopApp'

type Result = { memories: EngineMemory[] } | { error: string }

function MemoryList({ agentId, refresh }: { agentId: string; refresh: () => void }) {
    const [result, setResult] = useState<Result | null>(null)
    useEffect(() => {
        const controller = new AbortController()
        async function load() {
            try {
                const response = await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/memories`, { cache: 'no-store', signal: controller.signal })
                if (!response.ok) throw new Error('Could not load coworker memories.')
                const data = memoriesListSchema.parse(await response.json())
                if (!controller.signal.aborted) setResult(data)
            } catch {
                if (!controller.signal.aborted) setResult({ error: 'Could not load coworker memories. Try again.' })
            }
        }
        void load()
        return () => controller.abort()
    }, [agentId])

    return <>
        <div className="min-h-0 overflow-y-auto">
            {!result ? <p role="status" className="text-sm text-muted-foreground">Loading memories…</p>
                : 'error' in result ? <p role="alert" className="text-sm text-destructive">{result.error}</p>
                : result.memories.length ? <PanelList>{result.memories.map(memory => <MemoryRow key={memory.id} memory={memory} />)}</PanelList>
                : <EmptyState icon={BrainIcon} title="No memories yet" description="Saved memories for this coworker will appear here." />}
        </div>
        <DialogFooter>
            {result && <Button type="button" variant="outline" onClick={refresh}>{'error' in result ? 'Retry' : 'Refresh'}</Button>}
            <DialogClose asChild><Button type="button">Done</Button></DialogClose>
        </DialogFooter>
    </>
}

export function DesktopCoworkerMemories({ agent }: { agent: DesktopAgentView }) {
    const [open, setOpen] = useState(false)
    const [revision, setRevision] = useState(0)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm">Memories</Button></DialogTrigger>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl">
            <DialogHeader>
                <DialogTitle>Memories</DialogTitle>
                <DialogDescription>Saved memories for {agent.name}.</DialogDescription>
            </DialogHeader>
            {open && <MemoryList key={`${agent.id}:${revision}`} agentId={agent.id} refresh={() => setRevision(value => value + 1)} />}
        </DialogContent>
    </Dialog>
}
