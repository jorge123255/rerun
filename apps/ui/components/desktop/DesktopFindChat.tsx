'use client'

import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { desktopChatSearchSchema, type DesktopConversationHit } from '@/lib/desktop/chat-search'

function FindChatPanel({ onSelect }: { onSelect: (hit: DesktopConversationHit) => void }) {
    const [query, setQuery] = useState('')
    const [attempt, setAttempt] = useState(0)
    const [answer, setAnswer] = useState<{ text: string; hits: DesktopConversationHit[]; hasMore: boolean; failed?: boolean } | null>(null)
    const text = query.trim()
    useEffect(() => {
        if (text.length < 2) return
        const controller = new AbortController()
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const response = await fetch(`/api/desktop/conversations/search?q=${encodeURIComponent(text)}`, { signal: controller.signal, cache: 'no-store' })
                    if (!response.ok) throw new Error('Search unavailable')
                    const result = desktopChatSearchSchema.parse(await response.json())
                    if (!controller.signal.aborted) setAnswer({ text, ...result })
                } catch {
                    if (!controller.signal.aborted) setAnswer({ text, hits: [], hasMore: false, failed: true })
                }
            })()
        }, 250)
        return () => { clearTimeout(timer); controller.abort() }
    }, [text, attempt])
    const shown = answer?.text === text ? answer : null

    return <Command shouldFilter={false} loop className="min-h-0">
        <CommandInput aria-label="Search saved chat titles" placeholder="Search saved chat titles…" value={query} onValueChange={setQuery} maxLength={200} />
        <CommandList aria-label="Saved chat results" className="max-h-[min(26rem,50dvh)]">
            {text.length < 2 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">Type at least 2 characters to find a saved chat.</p>
                : !shown ? <p role="status" className="px-3 py-6 text-sm text-muted-foreground">Searching chats…</p>
                : shown.failed ? <div role="alert" className="space-y-2 px-3 py-4 text-sm text-destructive">
                    <p>Could not search saved chats. Try again.</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => { setAnswer(null); setAttempt(value => value + 1) }}>Retry search</Button>
                </div>
                : shown.hits.length === 0 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matching chats.</p>
                : <CommandGroup heading="Conversations">
                    {shown.hits.map(hit => <CommandItem key={hit.id} value={hit.id} onSelect={() => onSelect(hit)} className="min-h-11 gap-3 py-2.5">
                        <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                        <span className="max-w-[45%] truncate text-xs text-muted-foreground">{hit.agentName}</span>
                    </CommandItem>)}
                </CommandGroup>}
        </CommandList>
        {shown?.hasMore && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Showing the first 50 matches. Refine your search for more.</p>}
    </Command>
}

export function DesktopFindChat({ onSelect }: { onSelect: (hit: DesktopConversationHit) => void }) {
    const [open, setOpen] = useState(false)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><Button type="button" variant="outline" size="sm"><Search aria-hidden className="size-4" />Find chat</Button></DialogTrigger>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-3 overflow-hidden sm:max-w-xl">
            <DialogHeader className="shrink-0">
                <DialogTitle>Find chat</DialogTitle>
                <DialogDescription>Search saved chat titles across this workspace.</DialogDescription>
            </DialogHeader>
            {open && <FindChatPanel onSelect={hit => { setOpen(false); onSelect(hit) }} />}
        </DialogContent>
    </Dialog>
}
