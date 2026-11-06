'use client'
import { useEffect, useRef, useState } from 'react'
import type { VoiceMessage } from '@rerun/contracts'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import { CheckIcon, CopyIcon } from '@/lib/icons'
import { Captions as CaptionsIcon } from 'lucide-react'
import { useCopy } from '@/lib/use-copy'
import { cn } from '@/lib/utils'
import { copyTranscriptText, type SavedVoiceAlignment } from '@/lib/desktop/chat-interactions/voice'
import { interactionKey, sameInteraction, type ChatInteractionIdentity } from '@/lib/desktop/chat-interactions/identity'
import { DesktopVoiceTranscript } from './DesktopVoiceTranscript'
export type DesktopVoiceTranscriptActionsProps = {
    identity: ChatInteractionIdentity; current(): ChatInteractionIdentity | null
    voice: VoiceMessage; active: boolean; elapsedMs: number; playing: boolean
    alignment?: SavedVoiceAlignment | null; defaultTranscriptOpen?: boolean
}
export function DesktopVoiceTranscriptActions(props: DesktopVoiceTranscriptActionsProps) {
    return <VoiceActions key={interactionKey(props.identity)} {...props} />
}
function VoiceActions(props: DesktopVoiceTranscriptActionsProps) {
    const latest = useRef(props); latest.current = props
    const mounted = useRef(false), [open, setOpen] = useState(props.defaultTranscriptOpen ?? false), [error, setError] = useState('')
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    const current = () => mounted.current && latest.current.active && sameInteraction(props.identity, latest.current.current())
    const { copied, copy } = useCopy(() => { if (current()) setError('Could not copy this transcript. Try again.') }, async text => {
        copyTranscriptText(text, current)
        await Promise.resolve()
        if (!current()) throw Error('This message is no longer current.')
    })
    if (!props.voice.transcript) return null
    return <div className="-mt-1 flex min-w-0 flex-col items-end group-[:not(:last-child)]:-mb-4">
        <DesktopVoiceTranscript identity={props.identity} {...props.voice} open={open} heardMs={props.active && (props.playing || props.elapsedMs > 0) ? props.elapsedMs : null} alignment={props.alignment} />
        <MessageActions className={cn('transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100 [@media(hover:none)]:opacity-100', !open && 'opacity-0')}>
            <MessageAction type="button" tooltip={open ? 'Hide transcript' : 'Transcript'} aria-expanded={open} disabled={!props.active}
                onClick={() => { if (current()) setOpen(value => !value) }} className={cn(open && 'bg-accent text-foreground')}><CaptionsIcon className="size-3.5" /></MessageAction>
            <MessageAction type="button" tooltip={copied ? 'Copied!' : 'Copy transcript'} disabled={!props.active} onClick={() => { if (current()) { setError(''); copy(latest.current.voice.transcript) } }}>
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </MessageAction>
        </MessageActions>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
}
