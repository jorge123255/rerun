'use client'

import { desktopPdfTextRunSlice, type DesktopPdfTextCrop, type DesktopPdfTextRun } from '@/lib/desktop/pdf-text'
import { useCallback, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'

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
    useLayoutEffect(() => {
        const layer = root.current
        if (!layer) return
        // PDFKit supplies the displayed word box, but not the original embedded font.
        // Fit the transparent selectable text to that box instead of clipping its last glyphs.
        const fit = () => {
            for (const run of layer.querySelectorAll<HTMLElement>('[data-pdf-text-start]')) {
                const letters = run.firstElementChild as HTMLElement | null
                if (letters && run.clientWidth > 0 && letters.scrollWidth > 0) letters.style.transform = `scaleX(${run.clientWidth / letters.scrollWidth})`
            }
        }
        fit()
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null
        observer?.observe(layer)
        return () => observer?.disconnect()
    }, [text, runs, rotation])
    const highlights = marks.flatMap(mark => runs.flatMap(run => {
        const box = desktopPdfTextRunSlice(run, mark.start, mark.end, rotation)
        return box ? [{ ...box, active: mark.active, key: `${mark.start}:${mark.end}:${run.start}` }] : []
    }))
    const copySelection = useCallback((event: ClipboardEvent) => {
        const layer = root.current, selection = window.getSelection()
        if (!layer || !event.clipboardData || !selection?.rangeCount || selection.isCollapsed || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return
        const range = selection.getRangeAt(0)
        let start = Infinity, end = -1
        for (const run of layer.querySelectorAll<HTMLElement>('[data-pdf-text-start]')) {
            const letters = run.firstElementChild
            if (!letters || !range.intersectsNode(letters)) continue
            const at = Number(run.dataset.pdfTextStart), length = letters.textContent?.length ?? 0
            const offset = (container: Node, position: number, fallback: number) => {
                if (!letters.contains(container)) return fallback
                const prefix = document.createRange()
                prefix.selectNodeContents(letters)
                prefix.setEnd(container, position)
                return Math.min(length, prefix.toString().length)
            }
            start = Math.min(start, at + offset(range.startContainer, range.startOffset, 0))
            end = Math.max(end, at + offset(range.endContainer, range.endOffset, length))
        }
        if (!Number.isFinite(start) || end <= start) return
        // Preserve the original whitespace between runs; adjacent positioned spans alone
        // would concatenate words (or synthesize line breaks) on the clipboard.
        event.clipboardData.setData('text/plain', text.slice(start, end))
        event.preventDefault()
    }, [text])
    useEffect(() => {
        // Selection in non-editable PDF text may leave focus on the document, so copy is
        // observed there and scoped back to this layer's two selection endpoints.
        document.addEventListener('copy', copySelection)
        return () => document.removeEventListener('copy', copySelection)
    }, [copySelection])
    const runStyle = (run: DesktopPdfTextRun): CSSProperties => {
        const sideways = rotation === 90 || rotation === 270
        const x = run.x + (rotation === 90 || rotation === 180 ? run.w : 0)
        const y = run.y + (rotation === 180 || rotation === 270 ? run.h : 0)
        return {
            position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`,
            width: sideways ? `${run.h * 100}cqh` : `${run.w * 100}cqw`,
            height: sideways ? `${run.w * 100}cqw` : `${run.h * 100}cqh`,
            fontSize: sideways ? `${run.w * 100}cqw` : `${run.h * 100}cqh`,
            color: 'transparent', userSelect: 'text', pointerEvents: 'auto', whiteSpace: 'pre', lineHeight: 1,
            fontFamily: 'Arial, sans-serif', transformOrigin: '0 0', transform: `rotate(${rotation}deg)`,
        }
    }
    const layerStyle = { containerType: 'size', pointerEvents: 'none' } as CSSProperties
    return <div ref={root} data-testid="file-pdf-text-layer" data-pdf-rotation={rotation} data-pdf-page-width={pageWidth} data-pdf-page-height={pageHeight} data-pdf-crop={`${crop.x},${crop.y},${crop.width},${crop.height}`} className="absolute inset-0" style={layerStyle}>
        <style>{'[data-testid="file-pdf-text-layer"] span::selection{background:rgba(255,208,0,.45);color:transparent}'}</style>
        {runs.map(run => <span key={`${run.start}:${run.end}`} data-pdf-text-start={run.start} style={runStyle(run)}><span style={{ display: 'inline-block', transformOrigin: '0 0' }}>{text.slice(run.start, run.end)}</span></span>)}
        {highlights.map(box => <span key={box.key} data-pdf-match={box.active ? 'active' : 'true'} aria-hidden="true" style={{
            position: 'absolute', pointerEvents: 'none', left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`,
            background: box.active ? 'rgba(255,196,0,.55)' : 'rgba(255,220,0,.35)',
        }} />)}
    </div>
}
