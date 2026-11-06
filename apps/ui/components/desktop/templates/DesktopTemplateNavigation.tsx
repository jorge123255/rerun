'use client'

import { useEffect, useRef, useState } from 'react'
import { createDesktopTemplatesClient, type DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import { createDesktopPortableTemplatesClient } from '@/lib/desktop/portable-template-client'
import { createDesktopPortableTemplateActions, type DesktopPortableTemplateActions } from '@/lib/desktop/portable-template-actions'
import { DesktopCreateTemplateDialog } from './DesktopCreateTemplateDialog'
import { DesktopTemplateLibraryDialog } from './DesktopTemplateLibraryDialog'
import type { DesktopTemplateIdentity, DesktopTemplateInstallIntent, DesktopTemplateInstallReceipt } from './types'
import type { DesktopBeginTemplatePlacement } from './useDesktopTemplatePlacement'

type PortableBridge = {
    pickImport: () => Promise<{ uploadId: string } | null>
    saveArtifact: (input: { artifactId: string }) => Promise<{ saved: boolean }>
}
type PortableControls = {
    actions: DesktopPortableTemplateActions
    pick: () => Promise<{ uploadId: string; requestId?: string } | null>
    save: (artifactId: string) => Promise<{ saved: boolean }>
}

export function DesktopTemplateNavigation({ onCreateFromScratch, onInstalled, onInstallAttempt, onPlaceTemplate, requestedTemplate, resumeInstall = null, open, onOpenChange, onActiveChange }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onActiveChange?: (active: boolean) => void
    onCreateFromScratch: () => void
    onInstalled: (receipt: DesktopTemplateInstallReceipt) => void
    onInstallAttempt?: (intent: DesktopTemplateInstallIntent | null) => void
    resumeInstall?: DesktopTemplateInstallIntent | null
    onPlaceTemplate?: DesktopBeginTemplatePlacement
    requestedTemplate?: DesktopTemplateIdentity | null
}) {
    const [client, setClient] = useState<DesktopTemplatesClient | null>(null)
    const [portable, setPortable] = useState<PortableControls | null>(null)
    const libraryOpen = open
    const setLibraryOpen = onOpenChange
    const [createOpen, setCreateOpen] = useState(false)
    const [initialTemplate, setInitialTemplate] = useState<DesktopTemplateIdentity | null>(requestedTemplate ?? null)
    const [seenRequest, setSeenRequest] = useState(requestedTemplate)
    if (requestedTemplate !== seenRequest) {
        setSeenRequest(requestedTemplate)
        if (requestedTemplate) setInitialTemplate(requestedTemplate)
    }
    const [returnToLibrary, setReturnToLibrary] = useState(false)
    const activeCallback = useRef(onActiveChange)
    activeCallback.current = onActiveChange

    // StrictMode remounts effects. A useMemo client would be disposed by the first cleanup and
    // then reused permanently; each effect lifetime instead owns its own live client.
    useEffect(() => {
        const next = createDesktopTemplatesClient()
        const packageClient = createDesktopPortableTemplatesClient()
        const bridge = (window as Window & { desktopApp?: { templates?: PortableBridge } }).desktopApp?.templates
        if (bridge) setPortable({
            actions: createDesktopPortableTemplateActions(packageClient),
            pick: async () => {
                const pending = await packageClient.pendingImport()
                return pending ? { uploadId: pending.uploadId, requestId: pending.requestId } : bridge.pickImport()
            },
            save: artifactId => bridge.saveArtifact({ artifactId }),
        })
        setClient(next)
        return () => { next.dispose(); packageClient.dispose() }
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
            onPlaceTemplate={onPlaceTemplate}
            portableActions={portable?.actions}
            onPickImport={portable?.pick}
            onSaveExport={portable?.save}
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
