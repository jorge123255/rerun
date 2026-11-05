'use client'

import { desktopPdfTextRunSlice, type DesktopPdfTextCrop, type DesktopPdfTextRun } from '@/lib/desktop/pdf-text'
import { useEffect, useRef, type CSSProperties } from 'react'

type Mark = { start: number; end: number; active: boolean }
type Props = {
    text: string
    rotation: number
    pageWidth: number
    pageHeight: number
    crop: DesktopPdfTextCrop
    runs: readonly DesktopPdfTextRun[]
    marks: readonly Mark[]
}

/** Transparent text aligned to the PNG. Coordinates are fractions of the displayed crop. */
export function DesktopFilePdfTextLayer({ text, rotation, pageWidth, pageHeight, crop, runs, marks }: Props) {
    const root = useRef<HTMLDivElement>(null)
    const active = marks.find(mark => mark.active)
    useEffect(() => {
        root.current?.querySelector('[data-pdf-match="active"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    }, [active?.start, active?.end, pageWidth, pageHeight])
    const highlights = marks.flatMap(mark => runs.flatMap(run => {
        const box = desktopPdfTextRunSlice(run, mark.start, mark.end)
        return box ? [{ ...box, active: mark.active, key: `${mark.start}:${mark.end}:${run.start}` }] : []
    }))
    const layerStyle = { containerType: 'size', pointerEvents: 'none' } as CSSProperties
    return <div ref={root} data-testid="file-pdf-text-layer" data-pdf-rotation={rotation} data-pdf-page-width={pageWidth} data-pdf-page-height={pageHeight} data-pdf-crop={`${crop.x},${crop.y},${crop.width},${crop.height}`} className="absolute inset-0" style={layerStyle}>
        <style>{'[data-testid="file-pdf-text-layer"] span::selection{background:rgba(255,208,0,.45);color:transparent}'}</style>
        {runs.map(run => <span key={`${run.start}:${run.end}`} style={{
            position: 'absolute', left: `${run.x * 100}%`, top: `${run.y * 100}%`, width: `${run.w * 100}%`, height: `${run.h * 100}%`,
            color: 'transparent', userSelect: 'text', pointerEvents: 'auto', whiteSpace: 'pre', overflow: 'hidden', lineHeight: 1,
            fontSize: `${run.h * 100}cqh`,
        }}>{text.slice(run.start, run.end)}</span>)}
        {highlights.map(box => <span key={box.key} data-pdf-match={box.active ? 'active' : 'true'} aria-hidden="true" style={{
            position: 'absolute', pointerEvents: 'none', left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`,
            background: box.active ? 'rgba(255,196,0,.55)' : 'rgba(255,220,0,.35)',
        }} />)}
    </div>
}
