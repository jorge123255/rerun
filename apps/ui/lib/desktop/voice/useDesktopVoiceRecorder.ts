'use client'

import { MAX_RECORDING_MS, RECORDING_BITS_PER_SECOND, markRecordingFormatBroken, pickBackupFormat, pickRecordingFormat, type RecordingFormat } from '@/lib/voice/recording'
import { DESKTOP_VOICE_MAX_BYTES } from '../../../../../packages/contracts/src/desktop-voice.ts'
import { useCallback, useEffect, useRef, useState } from 'react'

const SAMPLE_INTERVAL_MS = 50

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
}

function startTake(stream: MediaStream, format: RecordingFormat, onLimit: () => void): Take {
    const recorder = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: RECORDING_BITS_PER_SECOND })
    const take: Take = { recorder, format, chunks: [], bytes: 0, failed: false, byteLimited: false }
    recorder.addEventListener('dataavailable', event => {
        if (event.data.size <= 0) return
        take.bytes += event.data.size
        if (take.bytes > DESKTOP_VOICE_MAX_BYTES) {
            take.byteLimited = true
            onLimit()
            return
        }
        take.chunks.push(event.data)
    })
    recorder.addEventListener('error', () => { take.failed = true })
    return take
}

function stopTake(take: Take): Promise<void> {
    if (take.recorder.state === 'inactive') return Promise.resolve()
    return new Promise<void>(resolve => {
        let finished = false
        const timer = setTimeout(() => {
            if (!finished) { finished = true; resolve() }
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

export function useDesktopVoiceRecorder({ onError, onLimitReached }: {
    onError: (message: string) => void
    onLimitReached: () => void
}) {
    const [status, setStatus] = useState<DesktopVoiceRecorderStatus>('idle')
    const [stream, setStream] = useState<MediaStream | null>(null)
    const onErrorRef = useRef(onError)
    const onLimitReachedRef = useRef(onLimitReached)
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
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const limitFiredRef = useRef(false)
    const sessionRef = useRef(0)

    const releaseHardware = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
        analyserRef.current?.disconnect()
        analyserRef.current = null
        audioContextRef.current?.close().catch(() => {})
        audioContextRef.current = null
        for (const track of streamRef.current?.getTracks() ?? []) track.stop()
        streamRef.current = null
        setStream(null)
    }, [])

    useEffect(() => releaseHardware, [releaseHardware])

    const sample = useCallback(() => {
        const analyser = analyserRef.current
        if (analyser) {
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
            onLimitReachedRef.current()
        }
    }, [])

    const getLiveState = useCallback((): DesktopVoiceLiveState => ({ durationMs: startedAtRef.current ? Date.now() - startedAtRef.current : 0 }), [])

    const start = useCallback(async (): Promise<boolean> => {
        if (takesRef.current.length > 0) return false
        const session = ++sessionRef.current
        const format = pickRecordingFormat()
        if (!format || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
            onErrorRef.current('Voice messages are not supported in this browser.')
            return false
        }
        setStatus('starting')
        let mediaStream: MediaStream
        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        } catch (error) {
            if (session === sessionRef.current) setStatus('idle')
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

        try {
            const takes = [startTake(mediaStream, format, () => onLimitReachedRef.current()), ...backupTake(mediaStream, format, () => onLimitReachedRef.current())]
            levelsRef.current = []
            limitFiredRef.current = false
            const audioContext = new AudioContext()
            const analyser = audioContext.createAnalyser()
            analyser.fftSize = 1024
            audioContext.createMediaStreamSource(mediaStream).connect(analyser)
            void audioContext.resume().catch(() => {})
            mediaStream.addEventListener('inactive', () => onLimitReachedRef.current(), { once: true })

            streamRef.current = mediaStream
            setStream(mediaStream)
            audioContextRef.current = audioContext
            analyserRef.current = analyser
            takesRef.current = takes
            startedAtRef.current = Date.now()
            for (const take of takes) take.recorder.start()
            setStatus('recording')
            intervalRef.current = setInterval(sample, SAMPLE_INTERVAL_MS)
            return true
        } catch {
            releaseHardware()
            takesRef.current = []
            setStatus('idle')
            onErrorRef.current('Could not start recording.')
            return false
        }
    }, [releaseHardware, sample])

    const settle = useCallback(async (keep: boolean): Promise<DesktopVoiceRecordingTake | null> => {
        sessionRef.current++
        const takes = takesRef.current
        takesRef.current = []
        const durationMs = startedAtRef.current ? Date.now() - startedAtRef.current : 0
        const levels = levelsRef.current
        await Promise.all(takes.map(stopTake))
        releaseHardware()
        setStatus('idle')
        const [primary] = takes
        if (primary?.failed) markRecordingFormatBroken(primary.format.mimeType)
        if (!keep) return null
        const usable = takes.find(take => !take.failed && take.chunks.length > 0)
        if (!usable) return null
        const blob = new Blob(usable.chunks, { type: usable.format.mimeType })
        const limited = takes.some(take => take.byteLimited)
        return blob.size > 0 ? { blob, durationMs, levels, format: usable.format, limited } : null
    }, [releaseHardware])

    const stop = useCallback(() => settle(true), [settle])
    const cancel = useCallback(() => { void settle(false) }, [settle])
    return { status, stream, getLiveState, start, stop, cancel }
}
