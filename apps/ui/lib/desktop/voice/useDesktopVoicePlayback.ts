'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { DESKTOP_VOICE_MAX_BYTES } from '../../../../../packages/contracts/src/desktop-voice.ts'

export function useDesktopVoicePlayback({ srcUrl, blob, ownerKey }: {
    srcUrl?: string | null
    blob?: Blob | null
    ownerKey: string
}) {
    const audioRef = useRef<HTMLAudioElement | null>(null)
    const objectUrlRef = useRef<string | null>(null)
    const controllerRef = useRef<AbortController | null>(null)
    const generation = useRef(0)
    const [loading, setLoading] = useState(false)
    const [playing, setPlaying] = useState(false)
    const [elapsedMs, setElapsedMs] = useState(0)
    const [error, setError] = useState<string | null>(null)

    const stopAudio = useCallback(() => {
        generation.current++
        controllerRef.current?.abort()
        controllerRef.current = null
        const audio = audioRef.current
        if (audio) {
            audio.pause()
            audio.removeAttribute('src')
            try { audio.load() } catch { /* Detached audio is already released. */ }
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
        setPlaying(false)
        setLoading(false)
        setElapsedMs(0)
    }, [])

    useEffect(() => {
        setError(null)
        return stopAudio
    }, [srcUrl, blob, ownerKey, stopAudio])

    const load = useCallback(async (): Promise<string | null> => {
        if (objectUrlRef.current) return objectUrlRef.current
        const token = generation.current
        setLoading(true)
        setError(null)
        const controller = new AbortController()
        controllerRef.current = controller
        try {
            let nextBlob = blob ?? null
            if (!nextBlob && srcUrl) {
                const response = await fetch(srcUrl, { cache: 'no-store', signal: controller.signal })
                const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
                if (!response.ok || !mimeType.startsWith('audio/')) throw new Error('Could not load this recording')
                const bytes = await response.arrayBuffer()
                if (bytes.byteLength < 1 || bytes.byteLength > DESKTOP_VOICE_MAX_BYTES) throw new Error('This recording is damaged and cannot be played.')
                nextBlob = new Blob([bytes], { type: mimeType })
            }
            if (!nextBlob || generation.current !== token || controller.signal.aborted) return null
            const url = URL.createObjectURL(nextBlob)
            objectUrlRef.current = url
            return url
        } catch (cause) {
            if (generation.current === token && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load this recording')
            return null
        } finally {
            if (generation.current === token) {
                controllerRef.current = null
                setLoading(false)
            }
        }
    }, [blob, srcUrl])

    const toggle = useCallback(async () => {
        const audio = audioRef.current
        if (!audio) return
        if (playing) {
            audio.pause()
            return
        }
        if (!audio.src) {
            const url = await load()
            if (!url) return
            audio.src = url
        }
        await audio.play().catch(() => setError('This audio can’t be played.'))
    }, [load, playing])

    const seek = useCallback((event: React.MouseEvent<HTMLButtonElement>, durationMs: number) => {
        const audio = audioRef.current
        if (!audio?.src || durationMs <= 0) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
        audio.currentTime = (ratio * durationMs) / 1000
        setElapsedMs(ratio * durationMs)
    }, [])

    return {
        audioRef,
        loading,
        playing,
        elapsedMs,
        error,
        toggle,
        seek,
        stopAudio,
        audioProps: {
            onPlay: () => setPlaying(true),
            onPause: () => setPlaying(false),
            onEnded: () => { setPlaying(false); setElapsedMs(0) },
            onTimeUpdate: (event: React.SyntheticEvent<HTMLAudioElement>) => setElapsedMs(event.currentTarget.currentTime * 1000),
            onError: () => setError('This audio can’t be played.'),
        },
    }
}
