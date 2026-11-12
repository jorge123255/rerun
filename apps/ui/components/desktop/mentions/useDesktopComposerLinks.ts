'use client'

import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'
import { useComposerLinks } from '@/hooks/useComposerLinks'
import type { TextRange } from '@/lib/chat/composer-links'
import { safeDesktopChatLink } from '../DesktopChatLinkLabel'

function splitsLink(before: string, after: string, ranges: (text: string) => TextRange[]) {
    const old = ranges(before)
    if (!old.length || before === after) return false
    let start = 0
    while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++
    let oldEnd = before.length, newEnd = after.length
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
        oldEnd--
        newEnd--
    }
    const next = ranges(after)
    const inside = (tokens: TextRange[], offset: number) => tokens.some(token => token.start < offset && offset < token.end)
    return (inside(old, start) && !inside(next, start)) || (inside(old, oldEnd) && !inside(next, newEnd))
}

/** Keep the textarea's compact labels separate from the durable, unabridged draft. */
export function useDesktopComposerLinks(text: string, field: RefObject<HTMLTextAreaElement | null>, scope?: string) {
    const { collapse, clear, refresh, expand, ranges, ...links } = useComposerLinks(undefined, safeDesktopChatLink)
    const [view, setView] = useState<{ source: string; display: string; scope?: string }>()
    const current = view?.source === text && view.scope === scope
    const value = current ? view.display : text
    const record = useCallback((display: string, source: string) => {
        setView({ display, source, scope })
        refresh(display)
    }, [refresh, scope])

    useLayoutEffect(() => {
        if (current) return
        // An external restore, tab change, or send acknowledgement starts a fresh map.
        clear()
        record(collapse(text), text)
    }, [current, text, clear, collapse, record])

    function accept(element: HTMLTextAreaElement) {
        const display = element.value
        const source = expand(display)
        const limit = element.maxLength
        if (element.readOnly || element.disabled ||
            limit >= 0 && source.length > limit && source.length >= text.length ||
            splitsLink(value, display, ranges)) {
            element.value = value
            return null
        }
        record(display, source)
        return source
    }

    return {
        value, expand, record, accept,
        handlers: links.handlers,
        mirror: current && links.hasTokens ? {
            segments: links.segments,
            ref: (node: HTMLDivElement | null) => links.attachMirror(node, field.current),
            onPlaceCaret: (offset: number) => links.placeCaret(field.current, offset),
            onUnlink: (range: TextRange, url: string) => links.unlink(field.current, range, url),
        } : null,
    }
}
