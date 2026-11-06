'use client'

import { useIsMobile } from '@rerun/ui/primitives'
import { StepTransition } from '@rerun/ui/steps'
import { useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { TooltipLabeled } from '@/components/ui/tooltip'
import { ChevronLeftIcon, PanelRightCloseIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopPortableTemplateActions } from '@/lib/desktop/portable-template-actions'
import type { DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import { DesktopTemplateDetailPanel } from './DesktopTemplateDetailPanel'
import { DesktopTemplateLibraryBrowser } from './DesktopTemplateLibraryBrowser'
import type { DesktopTemplateDetail, DesktopTemplateIdentity, DesktopTemplateInstallIntent, DesktopTemplateInstallReceipt, DesktopTemplateSummary } from './types'

export function DesktopTemplateLibraryDialog({ open, client, initialTemplate = null, resumeInstall = null, onOpenChange, onCreateFromScratch, onNewTemplate, onInstalled, onInstallAttempt, portableActions = null, onPickImport, onSaveExport }: {
    open: boolean
    client: DesktopTemplatesClient
    initialTemplate?: DesktopTemplateIdentity | null
    resumeInstall?: DesktopTemplateInstallIntent | null
    onOpenChange: (open: boolean) => void
    onCreateFromScratch: () => void
    onNewTemplate: () => void
    onInstalled: (receipt: DesktopTemplateInstallReceipt) => void
    onInstallAttempt?: (intent: DesktopTemplateInstallIntent | null) => void
    portableActions?: DesktopPortableTemplateActions | null
    onPickImport?: () => Promise<{ uploadId: string; requestId?: string } | null>
    onSaveExport?: (artifactId: string) => Promise<{ saved: boolean }>
}) {
    const reduceMotion = useReducedMotion() ?? false
    const isMobile = useIsMobile()
    const [templates, setTemplates] = useState<DesktopTemplateSummary[]>([])
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [selection, setSelection] = useState<DesktopTemplateIdentity | null>(null)
    const [view, setView] = useState<'list' | 'detail'>('list')
    const [detail, setDetail] = useState<DesktopTemplateDetail | null>(null)
    const [lastDetail, setLastDetail] = useState<DesktopTemplateDetail | null>(null)
    const [detailLoading, setDetailLoading] = useState(false)
    const [detailError, setDetailError] = useState<string | null>(null)
    const [detailAttempt, setDetailAttempt] = useState(0)
    const [interrupted, setInterrupted] = useState<DesktopTemplateInstallIntent | null>(resumeInstall)
    const [openCount, setOpenCount] = useState(0)
    const [wasOpen, setWasOpen] = useState(false)
    const [importBusy, setImportBusy] = useState(false)
    const [importError, setImportError] = useState<string | null>(null)
    const importing = useRef(false)
    const listRequest = useRef(0)
    const currentlyOpen = useRef(open)
    currentlyOpen.current = open

    if (open !== wasOpen) {
        setWasOpen(open)
        if (open) {
            const requested = interrupted ?? initialTemplate
            setSelection(requested)
            setView(requested ? 'detail' : 'list')
            setOpenCount(count => count + 1)
        }
    }

    const refresh = useCallback(async (showLoading: boolean) => {
        if (!currentlyOpen.current) return
        const request = ++listRequest.current
        if (showLoading) setLoading(true)
        setLoadError(null)
        try {
            const result = await client.list()
            if (currentlyOpen.current && request === listRequest.current) setTemplates(result)
        } catch (error) {
            if (currentlyOpen.current && request === listRequest.current) setLoadError(error instanceof Error ? error.message : 'The local template library could not be read.')
        } finally {
            if (showLoading && currentlyOpen.current && request === listRequest.current) setLoading(false)
        }
    }, [client])

    useEffect(() => {
        if (resumeInstall) setInterrupted(resumeInstall)
    }, [resumeInstall])

    useEffect(() => {
        if (open) void refresh(true)
        return () => { listRequest.current++ }
    }, [open, refresh])

    useEffect(() => {
        if (!open) return
        if (!selection) {
            setDetail(null)
            setDetailError(null)
            return
        }
        let current = true
        setDetail(null)
        setDetailError(null)
        setDetailLoading(true)
        client.detail(selection).then(result => {
            if (!current) return
            if (result.templateId !== selection.templateId || result.revision !== selection.revision) {
                setDetailError('The saved revision changed. Reload the library and select the template again.')
                return
            }
            setDetail(result)
            setLastDetail(result)
        }).catch(error => {
            if (current) setDetailError(error instanceof Error ? error.message : 'This exact saved revision could not be read.')
        }).finally(() => {
            if (current) setDetailLoading(false)
        })
        return () => { current = false }
    }, [client, selection, detailAttempt, open])

    const listRef = useRef<HTMLDivElement>(null)
    const detailRef = useRef<HTMLDivElement>(null)
    const shownView = useRef(view)
    useEffect(() => {
        if (shownView.current === view) return
        shownView.current = view
        if (isMobile) (view === 'detail' ? detailRef : listRef).current?.focus()
    }, [view, isMobile])

    function select(template: DesktopTemplateSummary) {
        setSelection({ templateId: template.templateId, revision: template.revision })
        setView('detail')
    }

    function collapseDetail() {
        setSelection(null)
        setView('list')
        listRef.current?.focus()
    }

    async function importPackage() {
        if (!onPickImport || !portableActions || importing.current) return
        importing.current = true
        setImportBusy(true)
        setImportError(null)
        try {
            const picked = await onPickImport()
            if (!picked || !currentlyOpen.current) return
            const result = await portableActions.importPackage(picked)
            if (!currentlyOpen.current) return
            if (!result.ok) { setImportError(result.error); return }
            if (result.result.status === 'uncertain') { setImportError(result.result.reason); return }
            await refresh(true)
            if (!currentlyOpen.current) return
            setSelection({ templateId: result.result.templateId, revision: result.result.revision })
            setView('detail')
        } catch {
            if (currentlyOpen.current) setImportError('Could not finish importing the package. Choose Import to recover this attempt.')
        } finally { importing.current = false; setImportBusy(false) }
    }

    const shown = detail ?? (selection ? null : lastDetail)
    const resume = interrupted && selection && interrupted.templateId === selection.templateId && interrupted.revision === selection.revision ? interrupted : null

    return <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
            className="gap-0 overflow-hidden p-0 max-sm:h-dvh sm:max-w-[min(96rem,calc(100%-2rem))] lg:max-w-[min(96rem,calc(100%-8rem))]"
            onEscapeKeyDown={event => {
                if (!isMobile || view === 'list') return
                event.preventDefault()
                setView('list')
            }}
        >
            <DialogTitle className="sr-only">Private template library</DialogTitle>
            <div className={cn(
                'flex min-h-0 flex-1 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                'sm:grid sm:h-[min(56rem,92dvh)] lg:h-[min(56rem,calc(100dvh-6rem))]',
                reduceMotion ? 'sm:transition-none' : 'sm:transition-[grid-template-columns]',
                selection ? 'sm:grid-cols-[minmax(0,1fr)_420px]' : 'sm:grid-cols-[minmax(0,1fr)_0px]',
                view === 'detail' && 'max-sm:-translate-x-full',
            )}>
                <div ref={listRef} tabIndex={-1} inert={isMobile && view === 'detail'} className="flex w-full min-h-0 min-w-0 shrink-0 outline-none max-sm:pb-[env(safe-area-inset-bottom)] sm:w-auto">
                    <DesktopTemplateLibraryBrowser
                        key={openCount}
                        templates={templates}
                        loading={loading}
                        error={loadError}
                        selected={selection?.templateId ?? null}
                        onSelect={select}
                        onScratch={onCreateFromScratch}
                        onNewTemplate={onNewTemplate}
                        onRetry={() => void refresh(true)}
                        onImportPackage={onPickImport && portableActions ? () => { void importPackage() } : undefined}
                        importBusy={importBusy}
                        importError={importError}
                    />
                </div>
                <div ref={detailRef} tabIndex={-1} inert={isMobile ? view === 'list' : !selection} className="flex w-full min-h-0 min-w-0 shrink-0 flex-col outline-none sm:w-auto sm:overflow-hidden">
                    <div className="relative flex w-full min-h-0 flex-1 flex-col border-l max-sm:border-l-0 sm:w-[420px] sm:bg-muted/20 sm:shadow-[inset_2px_0_4px_0_rgb(0_0_0/0.05)]">
                        <div className="flex shrink-0 items-center border-b px-2 py-1.5 sm:hidden">
                            <Button type="button" variant="ghost" size="sm" className="gap-1.5 pl-1.5" onClick={() => setView('list')}><ChevronLeftIcon className="size-4" />Templates</Button>
                        </div>
                        <span className="absolute top-2 left-2 z-20 flex rounded-md bg-background/70 backdrop-blur max-sm:hidden">
                            <TooltipLabeled label="Hide details" side="bottom"><Button type="button" variant="ghost" size="icon-sm" aria-label="Hide details" onClick={collapseDetail}><PanelRightCloseIcon /></Button></TooltipLabeled>
                        </span>
                        <StepTransition stepKey={shown ? `${shown.templateId}:${shown.revision}` : selection ? 'loading' : 'empty'} direction={1} className="flex min-h-0 flex-1 flex-col">
                            {shown ? <DesktopTemplateDetailPanel
                                key={`${shown.templateId}:${shown.revision}`}
                                client={client}
                                template={shown}
                                resume={resume}
                                portableActions={portableActions}
                                onPickImport={onPickImport}
                                onSaveExport={onSaveExport}
                                onLibraryChanged={change => { if (change?.operation !== 'export') void refresh(false); if (change?.operation === 'delete' && change.templateId === shown.templateId) { setSelection(null); setView('list') } }}
                                onInterrupted={intent => {
                                    setInterrupted(intent)
                                    onInstallAttempt?.(intent)
                                }}
                                onInstalled={receipt => {
                                    setInterrupted(null)
                                    onInstalled(receipt)
                                }}
                            /> : detailLoading ? <DesktopTemplateDetailSkeleton /> : <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                                <p role="alert" className="text-sm text-destructive">{detailError ?? 'Select a template to read its exact saved revision.'}</p>
                                {selection && <Button type="button" variant="outline" size="sm" onClick={() => setDetailAttempt(attempt => attempt + 1)}>Try again</Button>}
                            </div>}
                        </StepTransition>
                    </div>
                </div>
            </div>
        </DialogContent>
    </Dialog>
}

function DesktopTemplateDetailSkeleton() {
    return <div role="status" aria-label="Loading saved template" className="flex min-h-0 flex-1 animate-pulse flex-col"><div className="aspect-video bg-muted" /><div className="flex flex-col gap-4 p-5"><div className="h-4 w-2/3 rounded bg-muted" /><div className="h-24 rounded-lg bg-muted" /><div className="h-32 rounded-lg bg-muted" /></div></div>
}
