'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { createDesktopTemplatesClient } from '@/lib/desktop/templates-client'
import { DesktopCreateTemplateDialog } from './DesktopCreateTemplateDialog'
import { DesktopTemplateLibraryDialog } from './DesktopTemplateLibraryDialog'
import type { DesktopTemplateIdentity, DesktopTemplateInstallIntent, DesktopTemplateInstallReceipt } from './types'

export function DesktopTemplateNavigation({ onCreateFromScratch, onInstalled, onInstallAttempt, resumeInstall = null }: {
    onCreateFromScratch: () => void
    onInstalled: (receipt: DesktopTemplateInstallReceipt) => void
    onInstallAttempt?: (intent: DesktopTemplateInstallIntent | null) => void
    resumeInstall?: DesktopTemplateInstallIntent | null
}) {
    const client = useMemo(() => createDesktopTemplatesClient(), [])
    const [libraryOpen, setLibraryOpen] = useState(false)
    const [createOpen, setCreateOpen] = useState(false)
    const [initialTemplate, setInitialTemplate] = useState<DesktopTemplateIdentity | null>(null)
    const [returnToLibrary, setReturnToLibrary] = useState(false)

    useEffect(() => () => client.dispose(), [client])

    return <>
        <Button type="button" variant="outline" onClick={() => {
            setInitialTemplate(null)
            setLibraryOpen(true)
        }}>Templates</Button>
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
            onInstalled={onInstalled}
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
