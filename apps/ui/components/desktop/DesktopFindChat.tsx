'use client'

import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { ChromeButton } from '@rerun/ui/chrome'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { SearchIcon } from '@/lib/icons'
import { desktopChatSearchSchema, type DesktopConversationHit } from '@/lib/desktop/chat-search'
import { useDesktopLocale } from './DesktopLocale'

function FindChatPanel({ onSelect }: { onSelect: (hit: DesktopConversationHit) => void }) {
    const { t } = useDesktopLocale()
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
        <CommandInput aria-label={t('boardUI.input')} placeholder={t('boardUI.placeholder')} value={query} onValueChange={setQuery} maxLength={200} />
        <CommandList aria-label={t('boardUI.results')} className="max-h-[min(26rem,50dvh)]">
            {text.length < 2 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('boardUI.minimum')}</p>
                : !shown ? <p role="status" className="px-3 py-6 text-sm text-muted-foreground">{t('boardUI.searching')}</p>
                : shown.failed ? <div role="alert" className="space-y-2 px-3 py-4 text-sm text-destructive">
                    <p>{t('boardUI.failed')}</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => { setAnswer(null); setAttempt(value => value + 1) }}>{t('boardUI.retry')}</Button>
                </div>
                : shown.hits.length === 0 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('boardUI.empty')}</p>
                : <CommandGroup heading={t('controlCenter.headings.conversations')}>
                    {shown.hits.map(hit => <CommandItem key={hit.id} value={hit.id} onSelect={() => onSelect(hit)} className="min-h-11 gap-3 py-2.5">
                        <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                        <span className="max-w-[45%] truncate text-xs text-muted-foreground">{hit.agentName}</span>
                    </CommandItem>)}
                </CommandGroup>}
        </CommandList>
        {shown?.hasMore && <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t('boardUI.truncated')}</p>}
    </Command>
}

export function DesktopFindChat({ onSelect, compactOnBoard = false }: { onSelect: (hit: DesktopConversationHit) => void; compactOnBoard?: boolean }) {
    const { t } = useDesktopLocale()
    const [open, setOpen] = useState(false)
    return <Dialog open={open} onOpenChange={setOpen} asSheet={false}>
        <DialogTrigger asChild><ChromeButton icon={Search} aria-label={t('boardUI.title')}
            className={compactOnBoard ? '@max-4xl/board:w-(--chrome-control) @max-4xl/board:px-0' : undefined}
            label={compactOnBoard ? <span className="@max-4xl/board:hidden">{t('boardUI.title')}</span> : t('boardUI.title')} /></DialogTrigger>
        <DialogContent closeLabel={t('closeDialog')} className="flex max-h-[85dvh] flex-col gap-3 overflow-hidden sm:max-w-xl">
            <DialogHeaderBar icon={SearchIcon} title={t('boardUI.title')} description={t('boardUI.description')} />
            {open && <FindChatPanel onSelect={hit => { setOpen(false); onSelect(hit) }} />}
        </DialogContent>
    </Dialog>
}
