'use client'

import { PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Spinner } from '@/components/ui/spinner'
import { MicIcon, RefreshCcwIcon, SendIcon, XIcon } from '@/lib/icons'
import type { DesktopVoiceLifecycle } from '@rerun/contracts'

export function DesktopVoiceComposerControls({ status, besideSend = false, disabled = false, onStart, onFinish, onTranscribe, onSend, onRetry, onDiscard, onRerecord }: {
    status: DesktopVoiceLifecycle
    besideSend?: boolean
    disabled?: boolean
    onStart: () => void
    onFinish: () => void
    onTranscribe: () => void
    onSend: () => void
    onRetry: () => void
    onDiscard: () => void
    onRerecord: () => void
}) {
    if (status === 'idle') return <PromptInputButton variant={besideSend ? 'ghost' : 'default'} tooltip="Record a voice message" aria-label="Record a voice message" onClick={onStart} disabled={disabled}><MicIcon className="size-4" /></PromptInputButton>
    if (status === 'sent') return <PromptInputButton tooltip="Record another" aria-label="Record another voice message" onClick={onRerecord} disabled={disabled}><MicIcon className="size-4" /></PromptInputButton>

    const busy = ['starting', 'uploading', 'transcribing', 'sending'].includes(status)
    const action = status === 'ready' ? onSend : status === 'failed' || status === 'unavailable' ? onRetry : status === 'review' ? onTranscribe : onFinish
    const label = status === 'starting' ? 'Waiting for the microphone' : status === 'uploading' ? 'Saving recording' : status === 'transcribing' ? 'Transcribing' : status === 'sending' ? 'Sending'
        : status === 'ready' ? 'Send transcript' : status === 'failed' || status === 'unavailable' ? 'Retry' : status === 'review' ? 'Transcribe' : 'Stop and review'
    return <>
        <PromptInputButton tooltip="Discard" aria-label="Discard recording" onClick={onDiscard} disabled={['uploading', 'transcribing', 'sending'].includes(status)}><XIcon className="size-4" /></PromptInputButton>
        <PromptInputButton variant="default" tooltip={label} aria-label={label} onClick={action} disabled={busy || disabled && status !== 'recording'}>
            {busy ? <Spinner /> : status === 'failed' || status === 'unavailable' ? <RefreshCcwIcon className="size-4" /> : <SendIcon className="size-4" />}
        </PromptInputButton>
    </>
}
