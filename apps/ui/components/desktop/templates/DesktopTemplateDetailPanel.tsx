'use client'

import { TEMPLATE_CATEGORY_LABELS } from '@rerun/contracts'
import { CardCarousel, ScrollFade, Stripes } from '@rerun/ui/primitives'
import { TemplateBoardPreview } from '@rerun/ui/iso-grid'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Icon } from '@/components/ui/icon'
import { ShieldCheck } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import { DesktopTemplateDetailAgentCard } from './DesktopTemplateDetailAgentCard'
import type { DesktopTemplateDetail, DesktopTemplateInstallIntent, DesktopTemplateInstallReceipt, DesktopTemplateLibraryChange } from './types'
import type { DesktopPortableTemplateActions } from '@/lib/desktop/portable-template-actions'
import { DesktopTemplateDraftDelete } from './DesktopTemplateDraftDelete'
import { DesktopTemplatePortableActions } from './DesktopTemplatePortableActions'
import { DesktopTemplateFidelityReview } from './DesktopTemplateFidelityReview'
import { useDesktopTemplateInstall } from './useDesktopTemplateInstall'

export function DesktopTemplateDetailPanel({ client, template, resume = null, onInstalled, onInterrupted, portableActions = null, onLibraryChanged, onPickImport, onSaveExport }: {
    client: DesktopTemplatesClient
    template: DesktopTemplateDetail
    resume?: DesktopTemplateInstallIntent | null
    onInstalled: (receipt: DesktopTemplateInstallReceipt) => void
    onInterrupted?: (intent: DesktopTemplateInstallIntent | null) => void
    portableActions?: DesktopPortableTemplateActions | null
    onLibraryChanged?: (change?: DesktopTemplateLibraryChange) => void
    onPickImport?: () => Promise<{ uploadId: string; requestId?: string } | null>
    onSaveExport?: (artifactId: string) => Promise<{ saved: boolean }>
}) {
    const install = useDesktopTemplateInstall({ client, template, resume, onInstalled, onInterrupted })
    const canInstall = template.capturedAt !== null && template.agents.length > 0
    return <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
        <ScrollFade className="min-h-0 flex-1">
            <div className="relative flex aspect-video shrink-0 items-center justify-center overflow-hidden border-b bg-muted/40">
                {template.agents.length > 0 ? <TemplateBoardPreview key={template.revision} agents={template.agents} connectors={[]} className="size-full" /> : <Icon icon={ShieldCheck} size="lg" className="opacity-40" />}
                <span className="absolute right-3 top-3 rounded-full bg-background/70 px-2.5 py-1 text-[10px] text-muted-foreground backdrop-blur">Private</span>
            </div>
            <div className="flex flex-col gap-5 p-5">
                <div className="space-y-1.5"><h3 className="text-base font-medium">{template.title}</h3>{template.tagline && <p className="text-xs text-muted-foreground">{template.tagline}</p>}</div>
                <div className="relative flex flex-col gap-2.5 overflow-hidden rounded-lg border border-border/60 bg-muted/30 p-3">
                    <Stripes />
                    <MetaRow label="Coworkers" value={String(template.agents.length)} />
                    <MetaRow label="Category" value={TEMPLATE_CATEGORY_LABELS[template.category] ?? TEMPLATE_CATEGORY_LABELS.other} />
                    <MetaRow label="Captured" value={template.capturedAt ?? 'Draft — not captured'} />
                </div>
                {template.description && <Section title="About"><p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{template.description}</p></Section>}
                {template.agents.length > 0 && <Section title="Coworkers" count={template.agents.length}>
                    <CardCarousel label="coworkers in this template" fadeClassName="from-popover" className="gap-3" itemClassName={cn('shrink-0 snap-center', template.agents.length > 1 ? 'w-[85%]' : 'w-full')}>
                        {template.agents.map(agent => <DesktopTemplateDetailAgentCard key={agent.key} agent={agent} />)}
                    </CardCarousel>
                </Section>}
                {template.fidelityCoworkers && <DesktopTemplateFidelityReview coworkers={template.fidelityCoworkers} />}
                <SavedIssues title="Excluded from capture" issues={template.exclusions} />
                <SavedIssues title="Unsupported entries" issues={template.unsupportedEntries} />
                <Alert variant="warning" stripes className="grid-cols-[auto_1fr] gap-x-3 gap-y-0">
                    <Icon icon={ShieldCheck} size="sm" className="row-span-2 self-center" />
                    <AlertTitle className="col-start-2 leading-tight">Local template security</AlertTitle>
                    <AlertDescription className="col-start-2 leading-snug">Credential stores, histories, grants and connector skills do not travel. Private prose in selected files and instructions was left for the author to review, not automatically stripped.</AlertDescription>
                </Alert>
            </div>
        </ScrollFade>
        <div className="border-t bg-muted/50 px-5 py-4 max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {portableActions && template.draftRevision && <DesktopTemplateDraftDelete templateId={template.templateId} revision={template.draftRevision} title={template.title} actions={portableActions} onDeleted={templateId => onLibraryChanged?.({ operation: 'delete', templateId })} />}
            {portableActions && !template.draftRevision && <div className="mb-3"><DesktopTemplatePortableActions template={template} actions={portableActions} onLibraryChanged={onLibraryChanged ?? (() => undefined)} onPickImport={onPickImport} onSaveExport={onSaveExport} /></div>}
            {install.receipt && <p role="status" className="mb-2 text-center text-xs text-muted-foreground">Previously used · {install.receipt.coworkers.length} coworker{install.receipt.coworkers.length === 1 ? '' : 's'} still in this workspace</p>}
            {install.error && <p role="alert" className="mb-2 text-center text-xs text-destructive">{install.error}</p>}
            <Button type="button" className="w-full" loading={install.busy} disabled={!canInstall || install.busy} title={!canInstall ? 'Capture at least one coworker before installing.' : undefined} onClick={install.readFailed ? install.refresh : install.receipt ? install.again : install.run}>
                {install.checking ? 'Checking previous use…' : install.readFailed ? 'Try again' : install.receipt ? 'Use again' : install.cleanupPending ? 'Retry cleanup' : install.interrupted ? 'Retry installation' : 'Use template'}
            </Button>
            {install.interrupted && !install.cleanupPending && <ConfirmDialog title="Remove this unfinished installation?" description="This cancels the saved installation and removes only its unused, unchanged copies. Copies already on the board or containing new work are kept. You can use the template again after cleanup finishes." confirmLabel="Remove unfinished copies" onConfirm={() => void install.rollback()} pending={install.busy}>
                <Button type="button" variant="ghost" className="mt-2 w-full" disabled={install.busy}>Remove unfinished copies</Button>
            </ConfirmDialog>}
            <p className="mt-2 text-center text-[11px] text-muted-foreground">{canInstall ? 'Creates fresh coworkers with empty histories and tools switched off.' : 'Capture at least one coworker before installing this draft.'}</p>
        </div>
    </div>
}

function MetaRow({ label, value }: { label: string; value: string }) {
    return <div className="relative flex items-center justify-between gap-4 text-xs"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium">{value}</span></div>
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
    return <div className="space-y-2"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}{count !== undefined && <span className="text-muted-foreground/60"> · {count}</span>}</p>{children}</div>
}

function SavedIssues({ title, issues }: { title: string; issues: { path: string; reason: string }[] }) {
    if (issues.length === 0) return null
    return <Section title={title} count={issues.length}><ul className="flex flex-col gap-2">{issues.map(issue => <li key={`${issue.path}:${issue.reason}`} className="rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"><code className="block break-all text-xs">{issue.path}</code><p className="mt-1 text-[11px] text-muted-foreground">{issue.reason}</p></li>)}</ul></Section>
}
