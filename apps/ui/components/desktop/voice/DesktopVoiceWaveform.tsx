'use client'

import { cn } from '@/lib/utils'
import { formatVoiceDuration } from '@/lib/voice/duration'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useRef, useState } from 'react'

export function DesktopVoiceWaveform({ peaks, progress = 0, barWidth = 3, barGap = 1, barRadius = 1.5, minBarHeight = 4, height = 32, className }: {
    peaks: readonly number[]
    progress?: number
    barWidth?: number
    barGap?: number
    barRadius?: number
    minBarHeight?: number
    height?: number
    className?: string
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [width, setWidth] = useState(0)
    const [barColor, setBarColor] = useState('')
    const { resolvedTheme } = useTheme()

    useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
        observer.observe(canvas)
        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        const canvas = canvasRef.current
        if (canvas) setBarColor(getComputedStyle(canvas).color)
    }, [resolvedTheme])

    const draw = useCallback(() => {
        const canvas = canvasRef.current
        if (!canvas || width <= 0 || !barColor) return
        const dpr = window.devicePixelRatio || 1
        canvas.width = width * dpr
        canvas.height = height * dpr
        const context = canvas.getContext('2d')
        if (!context) return
        context.scale(dpr, dpr)
        context.clearRect(0, 0, width, height)
        const step = barWidth + barGap
        const count = Math.max(1, Math.floor(width / step))
        const playedUntil = progress * count
        context.fillStyle = barColor
        for (let index = 0; index < count; index++) {
            const value = peaks.length > 0 ? (peaks[Math.floor((index / count) * peaks.length)] ?? 0) : 0
            const barHeight = Math.max(minBarHeight, value * height * 0.8)
            const alpha = 0.4 + value * 0.6
            context.globalAlpha = index < playedUntil ? alpha : alpha * 0.3
            context.beginPath()
            context.roundRect(index * step, (height - barHeight) / 2, barWidth, barHeight, barRadius)
            context.fill()
        }
        context.globalAlpha = 1
    }, [width, height, barWidth, barGap, barRadius, minBarHeight, peaks, progress, barColor])

    useEffect(draw, [draw])
    return <canvas ref={canvasRef} aria-hidden className={cn('block w-full min-w-0', className)} style={{ height }} />
}

export function DesktopVoiceSeek({ peaks, elapsedMs, durationMs, label, disabled, onSeek, className }: {
    peaks: readonly number[]
    elapsedMs: number
    durationMs: number
    label: string
    disabled: boolean
    onSeek: (positionMs: number) => void
    className?: string
}) {
    const position = Math.min(elapsedMs, durationMs)
    return <div className={cn('relative min-w-0 rounded-sm focus-within:ring-2 focus-within:ring-current', className)}>
        <DesktopVoiceWaveform peaks={peaks} progress={durationMs > 0 ? position / durationMs : 0} />
        <input type="range" min={0} max={durationMs} step="any" value={position} aria-label={label}
            aria-valuetext={`${formatVoiceDuration(position)} / ${formatVoiceDuration(durationMs)}`}
            disabled={disabled || durationMs <= 0} onChange={event => onSeek(event.currentTarget.valueAsNumber)}
            className="absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default" />
    </div>
}
