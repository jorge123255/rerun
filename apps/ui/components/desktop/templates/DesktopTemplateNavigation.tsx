'use client'

import { useEffect, useRef, useState } from 'react'
import { createDesktopTemplatesClient, type DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import { DesktopCreateTemplateDialog } from './DesktopCreateTemplateDialog'
import { DesktopTemplateLibraryDialog } from './DesktopTemplateLibraryDialog'
import type { DesktopTemplateIdentity, DesktopTemplateInstallIntent, DesktopTemplateInstallReceipt } from './types'

export function DesktopTemplateNavigation({ onCreateFromScratch, onInstalled, onInstallAttempt, resumeInstall = null, open, onOpenChange, onActiveChange }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onActiveChange?: (active: boolean) => void
    onCreateFromScratch: () => void
    onInstalled: (receipt: DesktopTemplateInstallReceipt) => void
    onInstallAttempt?: (intent: DesktopTemplateInstallIntent | null) => void
    resumeInstall?: DesktopTemplateInstallIntent | null
}) {
    const [client, setClient] = useState<DesktopTemplatesClient | null>(null)
    const libraryOpen = open
    const setLibraryOpen = onOpenChange
    const [createOpen, setCreateOpen] = useState(false)
    const [initialTemplate, setInitialTemplate] = useState<DesktopTemplateIdentity | null>(null)
    const [returnToLibrary, setReturnToLibrary] = useState(false)
    const activeCallback = useRef(onActiveChange)
    activeCallback.current = onActiveChange

    // StrictMode remounts effects. A useMemo client would be disposed by the first cleanup and
    // then reused permanently; each effect lifetime instead owns its own live client.
    useEffect(() => {
        const next = createDesktopTemplatesClient()
        setClient(next)
        return () => next.dispose()
    }, [])
    useEffect(() => { onActiveChange?.(open || createOpen) }, [open, createOpen, onActiveChange])
    useEffect(() => () => activeCallback.current?.(false), [])

    if (!client) return null

    return <>
        <DesktopTemplateLibraryDialog
            open={libraryOpen}
            client={client}
            initialTemplate={initialTemplate}
            resumeInstall={resumeInstall}
            onOpenChange={setLibraryOpen}
            onCreateFromScratch={() => {
                setLibraryOpen(false)
                onCreateFromScratch()
            }}
            onNewTemplate={() => {
                setReturnToLibrary(true)
                setLibraryOpen(false)
                setCreateOpen(true)
            }}
            onInstalled={receipt => {
                setLibraryOpen(false)
                onInstalled(receipt)
            }}
            onInstallAttempt={onInstallAttempt}
        />
        <DesktopCreateTemplateDialog
            open={createOpen}
            client={client}
            onOpenChange={next => {
                setCreateOpen(next)
                if (!next && returnToLibrary) {
                    setReturnToLibrary(false)
                    setLibraryOpen(true)
                }
            }}
            onDone={template => {
                setInitialTemplate(template)
                setReturnToLibrary(false)
                setLibraryOpen(true)
            }}
        />
    </>
}
