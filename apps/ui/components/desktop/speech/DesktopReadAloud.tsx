'use client'

import { MessageAction } from '@/components/ai-elements/message'
import { desktopSpeechKey, desktopSpeechPlayer, useDesktopSpeechPlayer } from '@/lib/desktop/speech-player'
import { Loader2, SquareIcon, Volume2 } from '@/lib/icons'
import type { DesktopSpeechRequest } from '@/lib/desktop/speech'

/**
 * Speaks one saved reply with the owner's ElevenLabs voice. Only the reply's name is sent: the app
 * reads the words from the saved conversation. One reply speaks at a time.
 */
export function DesktopReadAloud({ agentId, sessionId, messageId, foreman, player = desktopSpeechPlayer }: {
    /** The coworker, or for the Chief of Staff the scope its conversations are keyed under. */
    agentId: string; sessionId: string; messageId: string
    /** Set for a Chief of Staff answer: `sessionId` is then its chat. */
    foreman?: { workspaceId: string }
    player?: typeof desktopSpeechPlayer
}) {
    const state = useDesktopSpeechPlayer(player)
    const key = desktopSpeechKey(agentId, sessionId, messageId)
    const request: DesktopSpeechRequest = foreman ? { foreman: { workspaceId: foreman.workspaceId, chatId: sessionId }, messageId } : { agentId, sessionId, messageId }
    const mine = state.key === key
    const loading = mine && state.phase === 'loading', playing = mine && state.phase === 'playing'
    const label = loading ? 'Stop (preparing the voice)' : playing ? 'Stop reading' : 'Read aloud'
    const error = state.error?.key === key ? state.error.message : ''
    return <>
        <MessageAction data-read-aloud={loading ? 'loading' : playing ? 'playing' : 'idle'} tooltip={label} aria-label={label} aria-pressed={mine}
            className={mine ? 'bg-accent text-foreground' : undefined}
            onClick={() => mine ? player.stop() : void player.play(key, request)}>
            {loading ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : playing ? <SquareIcon aria-hidden className="size-3.5" /> : <Volume2 aria-hidden className="size-3.5" />}
        </MessageAction>
        {playing && <span role="status" className="text-xs text-muted-foreground">{state.truncated === key ? 'Reading the first part of this long reply…' : 'Reading aloud…'}</span>}
        {error && <span role="alert" className="basis-full text-xs text-destructive">{error}</span>}
    </>
}
