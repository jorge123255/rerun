'use client'

import type { DesktopVoiceDraft, DesktopVoiceScope } from '../../../../../packages/contracts/src/desktop-voice.ts'
import { useDesktopVoiceMessage } from '@/lib/desktop/voice/useDesktopVoiceMessage'
import { DesktopVoiceComposerControls } from './DesktopVoiceComposerControls'
import { DesktopVoiceRecorderBar } from './DesktopVoiceRecorderBar'
import { DesktopVoiceReview } from './DesktopVoiceReview'

export function DesktopVoiceComposer({ agentId, tabUid, sessionId, besideSend = false, onSent }: DesktopVoiceScope & {
    besideSend?: boolean
    onSent?: (result: { draft: DesktopVoiceDraft; text: string }) => void
}) {
    const voice = useDesktopVoiceMessage({ agentId, tabUid, sessionId, onSent })
    const scope = { agentId, tabUid, sessionId }
    return <div className="relative flex w-full min-w-0 items-center gap-2">
        {voice.status === 'starting' || voice.status === 'recording'
            ? <DesktopVoiceRecorderBar status={voice.status} stream={voice.stream} getLiveState={voice.getLiveState} />
            : voice.status === 'idle' ? null : <DesktopVoiceReview scope={scope} take={voice.take} draft={voice.draft} error={voice.error} />}
        <div className="flex shrink-0 items-center gap-1">
            <DesktopVoiceComposerControls
                status={voice.status}
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
    </div>
}
