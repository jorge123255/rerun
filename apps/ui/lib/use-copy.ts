'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

const CONFIRMATION_MS = 1200
const writeClipboard = (value: string) => navigator.clipboard.writeText(value)

// Copy to the clipboard with the short "copied" confirmation the copy buttons share. The timer is
// cleared on unmount: a dialog closed right after a copy would otherwise set state on a dead node.
export function useCopy(onError?: () => void, writeText: (value: string) => void | Promise<void> = writeClipboard): { copied: boolean; copy: (value: string) => void } {
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current)
    }, [])

    const copy = useCallback(async (value: string) => {
        try {
            await writeText(value)
            setCopied(true)
            if (timer.current) clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), CONFIRMATION_MS)
        } catch {
            onError?.()
        }
    }, [onError, writeText])

    return { copied, copy }
}
