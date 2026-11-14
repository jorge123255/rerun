'use client'

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DesktopVoiceSendReceipt, DesktopVoiceScope, DesktopVoiceRevisionAction } from '@rerun/contracts'
import { useDesktopVoiceMessage } from '@/lib/desktop/voice/useDesktopVoiceMessage'
import { DesktopVoiceComposerControls } from './DesktopVoiceComposerControls'
import { DesktopVoiceRecorderBar } from './DesktopVoiceRecorderBar'
import { DesktopVoiceReview } from './DesktopVoiceReview'

export function DesktopVoiceComposer({ agentId, tabUid, sessionId, besideSend = false, disabled = false, active = true, reviewTarget, modelChoice, onActivity, onSent, onOpenTranscriptionSettings }: DesktopVoiceScope & {
    besideSend?: boolean
    disabled?: boolean
    active?: boolean
    reviewTarget?: HTMLElement | null
    modelChoice?: DesktopVoiceRevisionAction['modelChoice']
    onActivity?: (state: { busy: boolean; dirty: boolean }) => void
    onSent?: (result: DesktopVoiceSendReceipt & { text: string }) => void
    onOpenTranscriptionSettings?: () => void
}) {
    const voice = useDesktopVoiceMessage({ agentId, tabUid, sessionId, enabled: !disabled, active, modelChoice, onSent })
    const busy = ['starting', 'recording', 'uploading', 'transcribing', 'sending'].includes(voice.status)
    const dirty = busy || !!(voice.take || voice.draft && voice.status !== 'sent')
    useEffect(() => { onActivity?.({ busy, dirty }) }, [busy, dirty, onActivity])
    useEffect(() => () => onActivity?.({ busy: false, dirty: false }), [onActivity])
    const scope = { agentId, tabUid, sessionId }
    const review = voice.status === 'starting' || voice.status === 'recording'
            ? <DesktopVoiceRecorderBar status={voice.status} stream={voice.stream} getLiveState={voice.getLiveState} />
            : voice.status === 'idle' || voice.status === 'sent' ? null : <DesktopVoiceReview scope={scope} take={voice.take} draft={voice.draft}
                error={voice.error} active={active} onOpenTranscriptionSettings={onOpenTranscriptionSettings} />
    return <TooltipProvider><div className="relative flex min-w-0 shrink-0 items-center gap-2">
        {reviewTarget ? createPortal(review, reviewTarget) : review}
        <div className="flex shrink-0 items-center gap-1">
            <DesktopVoiceComposerControls
                status={voice.status}
                disabled={disabled || !active}
                besideSend={besideSend}
                onStart={() => void voice.start()}
                onFinish={() => void voice.finish()}
                onTranscribe={() => void voice.transcribe()}
                onSend={() => void voice.send()}
                onRetry={() => void voice.retry()}
                onDiscard={() => void voice.discard()}
                onRerecord={() => void voice.rerecord()}
            />
        </div>
    </div></TooltipProvider>
}
