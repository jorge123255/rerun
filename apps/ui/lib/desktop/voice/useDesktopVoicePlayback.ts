'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { DESKTOP_VOICE_MAX_BYTES } from '@rerun/contracts'

export async function readDesktopVoiceAudio(response: Response, signal: AbortSignal): Promise<Blob> {
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
    const declared = response.headers.get('content-length')
    if (!response.ok || !mimeType.startsWith('audio/') || !response.body || declared !== null && (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > DESKTOP_VOICE_MAX_BYTES)) {
        await response.body?.cancel().catch(() => {})
        throw new Error('This recording is damaged and cannot be played.')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let size = 0
    const abort = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    try {
        while (true) {
            signal.throwIfAborted()
            const next = await reader.read()
            signal.throwIfAborted()
            if (next.done) break
            size += next.value.byteLength
            if (size > DESKTOP_VOICE_MAX_BYTES) throw new Error('This recording is damaged and cannot be played.')
            chunks.push(new Uint8Array(next.value))
        }
        if (!size || declared !== null && size !== Number(declared)) throw new Error('This recording is incomplete and cannot be played.')
        return new Blob(chunks, { type: mimeType })
    } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}

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
    const [loaded, setLoaded] = useState(false)
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
        setLoaded(false)
        setElapsedMs(0)
    }, [])

    useEffect(() => {
        setError(null)
        return stopAudio
    }, [srcUrl, blob, ownerKey, stopAudio])

    const load = useCallback(async (): Promise<string | null> => {
        if (objectUrlRef.current) return objectUrlRef.current
        if (controllerRef.current) return null
        const token = generation.current
        setLoading(true)
        setError(null)
        const controller = new AbortController()
        controllerRef.current = controller
        try {
            let nextBlob = blob ?? null
            if (!nextBlob && srcUrl) {
                const response = await fetch(srcUrl, { cache: 'no-store', signal: controller.signal })
                nextBlob = await readDesktopVoiceAudio(response, controller.signal)
            }
            if (nextBlob && (nextBlob.size < 1 || nextBlob.size > DESKTOP_VOICE_MAX_BYTES)) throw new Error('This recording is damaged and cannot be played.')
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
        const token = generation.current
        if (!audio.src) {
            const url = await load()
            if (!url || generation.current !== token || audioRef.current !== audio) return
            audio.src = url
        }
        await audio.play().catch(() => {
            if (generation.current === token) setError('This audio can’t be played.')
        })
    }, [load, playing])

    const seek = useCallback((positionMs: number) => {
        const audio = audioRef.current
        if (!loaded || !audio?.src || !Number.isFinite(positionMs) || positionMs < 0) return
        const seconds = positionMs / 1000
        audio.currentTime = Number.isFinite(audio.duration) ? Math.min(seconds, audio.duration) : seconds
        setElapsedMs(audio.currentTime * 1000)
    }, [loaded])

    return {
        audioRef,
        loading,
        loaded,
        playing,
        elapsedMs,
        error,
        toggle,
        seek,
        stopAudio,
        audioProps: {
            onLoadedMetadata: () => setLoaded(true),
            onPlay: () => setPlaying(true),
            onPause: () => setPlaying(false),
            onEnded: () => { setPlaying(false); setElapsedMs(0) },
            onTimeUpdate: (event: React.SyntheticEvent<HTMLAudioElement>) => setElapsedMs(event.currentTarget.currentTime * 1000),
            onError: () => {
                setLoaded(false)
                setError('This audio can’t be played.')
            },
        },
    }
}
