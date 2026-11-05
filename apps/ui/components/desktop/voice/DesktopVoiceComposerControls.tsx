'use client'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Spinner } from '@/components/ui/spinner'
import { MicIcon, RefreshCcwIcon, SendIcon, XIcon } from '@/lib/icons'
import type { DesktopVoiceLifecycle } from '../../../../../packages/contracts/src/desktop-voice.ts'

export function DesktopVoiceComposerControls({ status, besideSend = false, onStart, onFinish, onTranscribe, onSend, onRetry, onDiscard, onRerecord }: {
    status: DesktopVoiceLifecycle
    besideSend?: boolean
    onStart: () => void
    onFinish: () => void
    onTranscribe: () => void
    onSend: () => void
    onRetry: () => void
    onDiscard: () => void
    onRerecord: () => void
}) {
    if (status === 'idle') return <PromptInputButton variant={besideSend ? 'ghost' : 'default'} tooltip="Record a voice message" aria-label="Record a voice message" onClick={onStart}><MicIcon className="size-4" /></PromptInputButton>
    if (status === 'sent') return <PromptInputButton tooltip="Record another" aria-label="Record another voice message" onClick={onRerecord}><MicIcon className="size-4" /></PromptInputButton>

    const busy = ['starting', 'uploading', 'transcribing', 'sending'].includes(status)
    const action = status === 'ready' ? onSend : status === 'failed' || status === 'unavailable' ? onRetry : status === 'review' ? onTranscribe : onFinish
    const label = status === 'ready' ? 'Send transcript' : status === 'failed' || status === 'unavailable' ? 'Retry' : status === 'review' ? 'Transcribe' : 'Stop and review'
    return <>
        <PromptInputButton tooltip="Discard" aria-label="Discard recording" onClick={onDiscard}><XIcon className="size-4" /></PromptInputButton>
        <PromptInputButton variant="default" tooltip={label} aria-label={label} onClick={action} disabled={busy}>
            {busy ? <Spinner /> : status === 'failed' || status === 'unavailable' ? <RefreshCcwIcon className="size-4" /> : <SendIcon className="size-4" />}
        </PromptInputButton>
    </>
}
