'use client'

import { type ClipboardEvent, type KeyboardEvent, type SyntheticEvent, type UIEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { collapseLinks, type ComposerLinks, type ComposerMention, type ComposerSegment, expandLinks, type TextRange, tokenizeComposer, tokenRanges, urlBeforeCaret } from '@/lib/chat/composer-links'

// execCommand is the only way to edit a textarea that keeps the browser's undo stack.
function replaceRange(el: HTMLTextAreaElement, { start, end }: TextRange, text: string) {
    el.focus()
    el.setSelectionRange(start, end)
    const done = text ? document.execCommand?.('insertText', false, text) : document.execCommand?.('delete')
    if (!done) {
        // The native setter leaves React's value tracker at the previous value until input.
        const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setValue?.call(el, el.value.slice(0, start) + text + el.value.slice(end))
        el.setSelectionRange(start + text.length, start + text.length)
        el.dispatchEvent(new Event('input', { bubbles: true }))
    }
}

function selection(el: HTMLTextAreaElement): TextRange {
    return { start: el.selectionStart, end: el.selectionEnd }
}

function widen({ start, end }: TextRange, ranges: TextRange[]): TextRange {
    for (const range of ranges) {
        if (range.start < start && start < range.end) start = range.start
        if (range.start < end && end < range.end) end = range.end
    }
    return { start, end }
}

const NO_MENTIONS: ComposerMention[] = []
const NO_LINKS: ComposerLinks = new Map()

/**
 * URLs in the composer are swapped for a short label, pasted or typed (on the space that ends
 * them), and a mirror over the textarea draws each label as a chip, and each known `@agent` or
 * `/skill` as a token. Both behave as one character: the caret skips over them, and a deletion
 * or a selection that touches one takes it whole. `expand` puts the full URLs back, for anything
 * that leaves the composer; a mention leaves as it was typed.
 */
export function useComposerLinks(mentions: ComposerMention[] = NO_MENTIONS, allowLink?: (url: string) => boolean) {
    const linksRef = useRef<ComposerLinks>(new Map())
    const mentionsRef = useRef(mentions)
    const mirrorElRef = useRef<HTMLDivElement | null>(null)
    const lastCaretRef = useRef(0)
    const [linkSegments, setLinkSegments] = useState<ComposerSegment[]>([])

    useEffect(() => {
        mentionsRef.current = mentions
    })

    // Split at render rather than on input: the skills arrive after the text when the `/` menu fetches them.
    const segments = useMemo(() => linkSegments.flatMap(segment => (segment.kind === 'text' ? tokenizeComposer(segment.text, NO_LINKS, mentions) : [segment])), [linkSegments, mentions])

    const refresh = useCallback((text: string) => setLinkSegments(tokenizeComposer(text, linksRef.current)), [])
    const ranges = useCallback((text: string) => tokenRanges(text, linksRef.current, mentionsRef.current), [])

    const expand = useCallback((text: string) => expandLinks(text, linksRef.current), [])
    const collapse = useCallback((text: string) => collapseLinks(text, linksRef.current, allowLink), [allowLink])
    const clear = useCallback(() => {
        linksRef.current.clear()
        setLinkSegments([])
    }, [])

    const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing) return
        const el = e.currentTarget
        if (el.disabled || el.readOnly) return
        const current = selection(el)
        const collapsed = current.start === current.end

        if (e.key === ' ' && collapsed && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const typed = urlBeforeCaret(el.value, current.start)
            if (!typed) return
            const label = collapse(typed.url)
            if (label === typed.url) return
            e.preventDefault()
            replaceRange(el, { start: typed.start, end: current.start }, `${label}${el.value.slice(typed.end, current.start)} `)
            return
        }

        const deleting = e.key === 'Backspace' || e.key === 'Delete'
        const typing = e.key.length === 1 && !e.metaKey && !e.ctrlKey
        if (!deleting && !typing) return
        const tokens = ranges(el.value)
        if (tokens.length === 0) return

        let target: TextRange | undefined
        if (collapsed) {
            if (!deleting) return
            const caret = current.start
            target = e.key === 'Backspace' ? tokens.find(range => range.start < caret && caret <= range.end) : tokens.find(range => range.start <= caret && caret < range.end)
        } else {
            const widened = widen(current, tokens)
            if (widened.start !== current.start || widened.end !== current.end) target = widened
        }
        if (!target) return
        e.preventDefault()
        replaceRange(el, target, deleting ? '' : e.key)
    }, [collapse, ranges])

    const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
        if (e.defaultPrevented || e.currentTarget.disabled || e.currentTarget.readOnly) return
        const pasted = e.clipboardData.getData('text/plain')
        if (!pasted) return
        const el = e.currentTarget
        const current = selection(el)
        const range = widen(current, ranges(el.value))
        const collapsed = collapse(pasted)
        if (collapsed === pasted && range.start === current.start && range.end === current.end) return
        e.preventDefault()
        replaceRange(el, range, collapsed)
    }, [collapse, ranges])

    const copySelection = useCallback((e: ClipboardEvent<HTMLTextAreaElement>, cut: boolean) => {
        const el = e.currentTarget
        if (cut && (el.disabled || el.readOnly)) return
        const range = widen(selection(el), ranges(el.value))
        if (range.start === range.end) return
        const selected = el.value.slice(range.start, range.end)
        const expanded = expandLinks(selected, linksRef.current)
        if (expanded === selected && range.start === el.selectionStart && range.end === el.selectionEnd) return
        e.preventDefault()
        e.clipboardData.setData('text/plain', expanded)
        if (cut) replaceRange(el, range, '')
    }, [ranges])
    const onCopy = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => copySelection(e, false), [copySelection])
    const onCut = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => copySelection(e, true), [copySelection])

    // A caret that lands inside a label jumps to the edge it was heading for, so arrows cross a chip in one step.
    const onSelect = useCallback((e: SyntheticEvent<HTMLTextAreaElement>) => {
        const el = e.currentTarget
        const caret = el.selectionStart
        if (caret === el.selectionEnd) {
            const inside = ranges(el.value).find(range => range.start < caret && caret < range.end)
            if (inside) {
                const last = lastCaretRef.current
                const target = last <= inside.start ? inside.end : last >= inside.end ? inside.start : caret - inside.start < inside.end - caret ? inside.start : inside.end
                el.setSelectionRange(target, target)
            }
        }
        lastCaretRef.current = el.selectionStart
    }, [ranges])

    const onScroll = useCallback((e: UIEvent<HTMLTextAreaElement>) => {
        if (mirrorElRef.current) mirrorElRef.current.scrollTop = e.currentTarget.scrollTop
    }, [])

    // The mirror only mounts once a token shows up, possibly under a textarea that has already scrolled.
    const attachMirror = useCallback((node: HTMLDivElement | null, textarea: HTMLTextAreaElement | null) => {
        mirrorElRef.current = node
        if (node && textarea) node.scrollTop = textarea.scrollTop
    }, [])

    /** Puts the full URL back as plain text, the way it was typed: one undo brings the chip back. */
    const unlink = useCallback((el: HTMLTextAreaElement | null, range: TextRange, url: string) => {
        if (el && !el.disabled && !el.readOnly) replaceRange(el, range, url)
    }, [])

    const placeCaret = useCallback((el: HTMLTextAreaElement | null, offset: number) => {
        if (!el) return
        el.focus({ preventScroll: true })
        el.setSelectionRange(offset, offset)
        lastCaretRef.current = offset
    }, [])

    return {
        segments,
        hasTokens: segments.some(segment => segment.kind !== 'text'),
        attachMirror,
        refresh,
        ranges,
        expand,
        collapse,
        clear,
        placeCaret,
        unlink,
        handlers: { onKeyDown, onPaste, onCopy, onCut, onSelect, onScroll },
    }
}
