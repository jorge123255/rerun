'use client'

import { MAX_RECORDING_MS, RECORDING_BITS_PER_SECOND, markRecordingFormatBroken, pickBackupFormat, pickRecordingFormat, type RecordingFormat } from '@/lib/voice/recording'
import { DESKTOP_VOICE_MAX_BYTES, DESKTOP_VOICE_MAX_LEVELS } from '@rerun/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'

const SAMPLE_INTERVAL_MS = 50
const CHUNK_INTERVAL_MS = 250

export type DesktopVoiceRecordingTake = { blob: Blob; durationMs: number; levels: number[]; format: RecordingFormat; limited?: boolean }
export type DesktopVoiceRecorderStatus = 'idle' | 'starting' | 'recording'
export type DesktopVoiceLiveState = { durationMs: number }

type Take = {
    recorder: MediaRecorder
    format: RecordingFormat
    chunks: Blob[]
    bytes: number
    failed: boolean
    byteLimited: boolean
    stopping?: Promise<void>
}

function startTake(stream: MediaStream, format: RecordingFormat, onLimit: () => void): Take {
    const recorder = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: RECORDING_BITS_PER_SECOND })
    const take: Take = { recorder, format, chunks: [], bytes: 0, failed: false, byteLimited: false }
    recorder.addEventListener('dataavailable', event => {
        if (event.data.size <= 0) return
        take.bytes += event.data.size
        if (take.bytes > DESKTOP_VOICE_MAX_BYTES) {
            take.byteLimited = true
            take.chunks = []
            onLimit()
            return
        }
        take.chunks.push(event.data)
    })
    recorder.addEventListener('error', () => { take.failed = true })
    return take
}

function stopTake(take: Take): Promise<void> {
    if (take.stopping) return take.stopping
    if (take.recorder.state === 'inactive') return Promise.resolve()
    return take.stopping = new Promise<void>(resolve => {
        let finished = false
        const timer = setTimeout(() => {
            if (!finished) { take.failed = true; finished = true; resolve() }
        }, 2000)
        take.recorder.addEventListener('stop', () => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            resolve()
        }, { once: true })
        try { take.recorder.stop() } catch {
            finished = true
            clearTimeout(timer)
            resolve()
        }
    })
}

function backupTake(stream: MediaStream, primary: RecordingFormat, onLimit: () => void): Take[] {
    const backup = pickBackupFormat(primary)
    if (!backup) return []
    try { return [startTake(stream, backup, onLimit)] } catch { return [] }
}

export function useDesktopVoiceRecorder({ onError, onLimitReached, onDispose }: {
    onError: (message: string) => void
    onLimitReached: () => void
    onDispose?: () => boolean
}) {
    const [status, setStatus] = useState<DesktopVoiceRecorderStatus>('idle')
    const [stream, setStream] = useState<MediaStream | null>(null)
    const onErrorRef = useRef(onError)
    const onLimitReachedRef = useRef(onLimitReached)
    const onDisposeRef = useRef(onDispose)
    onDisposeRef.current = onDispose
    useEffect(() => {
        onErrorRef.current = onError
        onLimitReachedRef.current = onLimitReached
    })

    const takesRef = useRef<Take[]>([])
    const streamRef = useRef<MediaStream | null>(null)
    const audioContextRef = useRef<AudioContext | null>(null)
    const analyserRef = useRef<AnalyserNode | null>(null)
    const levelsRef = useRef<number[]>([])
    const startedAtRef = useRef(0)
    const endedAtRef = useRef(0)
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const limitFiredRef = useRef(false)
    const sessionRef = useRef(0)
    const startingRef = useRef(false)

    const releaseHardware = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
        try { analyserRef.current?.disconnect() } catch {}
        analyserRef.current = null
        try { void audioContextRef.current?.close().catch(() => {}) } catch {}
        audioContextRef.current = null
        for (const track of streamRef.current?.getTracks() ?? []) { try { track.stop() } catch {} }
        streamRef.current = null
        setStream(null)
    }, [])

    useEffect(() => () => {
        if (onDisposeRef.current?.()) return
        sessionRef.current++
        startingRef.current = false
        for (const take of takesRef.current) void stopTake(take)
        takesRef.current = []
        releaseHardware()
    }, [releaseHardware])

    const sample = useCallback(() => {
        const analyser = analyserRef.current
        if (analyser && levelsRef.current.length < DESKTOP_VOICE_MAX_LEVELS) {
            const buffer = new Uint8Array(analyser.fftSize)
            analyser.getByteTimeDomainData(buffer)
            let sum = 0
            for (const value of buffer) {
                const centered = (value - 128) / 128
                sum += centered * centered
            }
            levelsRef.current.push(Math.min(1, Math.sqrt(sum / buffer.length) * 3))
        }
        if (Date.now() - startedAtRef.current >= MAX_RECORDING_MS && !limitFiredRef.current) {
            limitFiredRef.current = true
            endedAtRef.current = Date.now()
            onLimitReachedRef.current()
            for (const take of takesRef.current) void stopTake(take)
            releaseHardware()
        }
    }, [releaseHardware])

    const getLiveState = useCallback((): DesktopVoiceLiveState => ({ durationMs: startedAtRef.current ? Math.min(MAX_RECORDING_MS, Math.max(0, Date.now() - startedAtRef.current)) : 0 }), [])

    const start = useCallback(async (): Promise<boolean> => {
        if (takesRef.current.length > 0 || startingRef.current) return false
        startingRef.current = true
        const session = ++sessionRef.current
        const format = pickRecordingFormat()
        if (!format || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
            startingRef.current = false
            onErrorRef.current('Voice messages are not supported in this browser.')
            return false
        }
        setStatus('starting')
        let mediaStream: MediaStream
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        } catch (error) {
            if (session !== sessionRef.current) return false
            startingRef.current = false
            setStatus('idle')
            const name = error instanceof DOMException ? error.name : ''
            onErrorRef.current(name === 'NotAllowedError' || name === 'SecurityError'
                ? 'Microphone access is blocked. Allow it in your browser settings to record.'
                : name === 'NotReadableError' || name === 'AbortError'
                  ? 'The microphone is busy. Close other recording apps and try again.'
                  : 'No microphone available.')
            return false
        }
        if (session !== sessionRef.current) {
            for (const track of mediaStream.getTracks()) track.stop()
            return false
        }

        streamRef.current = mediaStream
        try {
            levelsRef.current = []
            limitFiredRef.current = false
            const limit = () => {
                if (session !== sessionRef.current || limitFiredRef.current) return
                limitFiredRef.current = true
                endedAtRef.current = Date.now()
                onLimitReachedRef.current()
                for (const take of takesRef.current) void stopTake(take)
                releaseHardware()
            }
            const takes = [startTake(mediaStream, format, limit)]
            takesRef.current = takes
            takes.push(...backupTake(mediaStream, format, limit))
            const audioContext = new AudioContext()
            audioContextRef.current = audioContext
            const analyser = audioContext.createAnalyser()
            analyserRef.current = analyser
            analyser.fftSize = 1024
            audioContext.createMediaStreamSource(mediaStream).connect(analyser)
            void audioContext.resume().catch(() => {})
            mediaStream.addEventListener('inactive', limit, { once: true })

            streamRef.current = mediaStream
            setStream(mediaStream)
            audioContextRef.current = audioContext
            analyserRef.current = analyser
            takesRef.current = takes
            startedAtRef.current = Date.now()
            endedAtRef.current = 0
            for (const take of takes) take.recorder.start(CHUNK_INTERVAL_MS)
            startingRef.current = false
            setStatus('recording')
            intervalRef.current = setInterval(sample, SAMPLE_INTERVAL_MS)
            return true
        } catch {
            for (const take of takesRef.current) void stopTake(take)
            releaseHardware()
            takesRef.current = []
            startingRef.current = false
            setStatus('idle')
            onErrorRef.current('Could not start recording.')
            return false
        }
    }, [releaseHardware, sample])

    const settle = useCallback(async (keep: boolean): Promise<DesktopVoiceRecordingTake | null> => {
        const session = ++sessionRef.current
        startingRef.current = false
        const takes = takesRef.current
        takesRef.current = []
        const durationMs = Math.min(MAX_RECORDING_MS, Math.max(1, startedAtRef.current ? (endedAtRef.current || Date.now()) - startedAtRef.current : 1))
        const levels = levelsRef.current.slice(0, DESKTOP_VOICE_MAX_LEVELS)
        const stopped = Promise.all(takes.map(stopTake))
        releaseHardware()
        startedAtRef.current = 0
        setStatus('idle')
        await stopped
        if (session !== sessionRef.current) return null
        const [primary] = takes
        if (primary?.failed) markRecordingFormatBroken(primary.format.mimeType)
        if (!keep) return null
        const usable = takes.find(take => !take.failed && !take.byteLimited && take.chunks.length > 0)
        if (!usable) {
            if (takes.some(take => take.byteLimited)) onErrorRef.current('Recording exceeded the size limit. Record a shorter message; incomplete audio was not saved.')
            return null
        }
        const blob = new Blob(usable.chunks, { type: usable.format.mimeType })
        const limited = takes.some(take => take.byteLimited)
        return blob.size > 0 ? { blob, durationMs, levels, format: usable.format, limited } : null
    }, [releaseHardware])

    const stop = useCallback(() => settle(true), [settle])
    const cancel = useCallback(() => settle(false), [settle])
    return { status, stream, getLiveState, start, stop, cancel }
}
