'use client'

import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { ChevronLeftIcon, ChevronRightIcon } from '@/lib/icons'
import type { SiblingFiles } from '@/components/files/useSiblingFiles'

/** FileDetail's previous / index / next cluster. The header slot supplies the row. */
export function FileSiblingControls({ siblings }: { siblings: SiblingFiles | null }) {
    if (!siblings) return null
    return <>
        <Button size="icon-sm" variant="ghost" onClick={siblings.previous} title="Previous file" aria-label="Previous file">
            <ChevronLeftIcon className="size-4" />
        </Button>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{siblings.index + 1} / {siblings.total}</span>
        <Button size="icon-sm" variant="ghost" onClick={siblings.next} title="Next file" aria-label="Next file">
            <ChevronRightIcon className="size-4" />
        </Button>
    </>
}

export function useFileSiblingKeys(siblings: SiblingFiles | null, viewerRef: { current: HTMLElement | null }) {
    useEffect(() => {
        if (!siblings) return
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
            const viewer = viewerRef.current
            if (!viewer || isTypingTarget(event.target) || isMediaSeekTarget(event.target) || isMediaSeekTarget(document.activeElement) || isInsideForeignOverlay(document.activeElement, viewer)) return
            event.preventDefault()
            if (event.key === 'ArrowLeft') siblings.previous()
            else siblings.next()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [siblings, viewerRef])
}

function isTypingTarget(target: EventTarget | null) {
    return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
}

// A focused <audio controls> or <video controls> uses the arrows to seek. Leave that default alone.
function isMediaSeekTarget(target: EventTarget | null) {
    return target instanceof Element && !!target.closest('audio, video')
}

// Files already sit inside the Files dialog, so that dialog is fine. A menu or dialog stacked on
// top of the viewer (editor, delete confirm, context menu) is not.
function isInsideForeignOverlay(active: Element | null, viewer: HTMLElement) {
    const overlay = active?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
    return Boolean(overlay && !overlay.contains(viewer))
}
