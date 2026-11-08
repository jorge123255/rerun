'use client'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { savedVoiceWords, type SavedVoiceAlignment } from '@/lib/desktop/chat-interactions/voice'
import type { ChatInteractionIdentity } from '@/lib/desktop/chat-interactions/identity'
const EASE_OUT = 'ease-[cubic-bezier(0.22,1,0.36,1)]'
export function DesktopVoiceTranscript({ identity, src, transcript, durationMs, open, heardMs, alignment }: {
    identity: ChatInteractionIdentity; src: string; transcript: string; durationMs: number
    open: boolean; heardMs: number | null; alignment?: SavedVoiceAlignment | null
}) {
    const words = useMemo(() => savedVoiceWords(identity, src, transcript, durationMs, alignment), [identity, src, transcript, durationMs, alignment])
    const elapsed = heardMs !== null && Number.isFinite(heardMs) && heardMs >= 0 ? heardMs : null
    return <div className={cn('grid w-full transition-[grid-template-rows] duration-500 motion-reduce:transition-none', EASE_OUT, open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')} aria-hidden={!open} inert={!open}>
        <div className="min-h-0 overflow-hidden">
            <p className={cn('mt-1 mb-1.5 ml-auto max-h-40 max-w-sm overflow-y-auto whitespace-pre-wrap border-r-2 border-brand/35 pr-3 text-right text-[13px] italic leading-relaxed break-words dark:border-brand/70',
                'transition-[opacity,translate,filter] duration-500 motion-reduce:transition-none', EASE_OUT,
                open ? 'translate-y-0 opacity-100 blur-none delay-75' : '-translate-y-1 opacity-0 blur-[2px]', !words && 'text-muted-foreground')}>
                {words ? words.map((word, index) => <span key={index} data-heard={word.startMs !== null && elapsed !== null ? word.startMs <= elapsed : undefined}
                    className={cn('transition-colors duration-200', elapsed === null || word.startMs === null ? 'text-muted-foreground' : word.startMs <= elapsed ? 'text-foreground/85' : 'text-muted-foreground/45')}>{word.text}</span>) : transcript}
            </p>
        </div>
    </div>
}
