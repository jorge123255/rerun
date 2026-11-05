'use client'

import { isSetupAnswered } from '@rerun/contracts'
import { CaptureReviewChips, CaptureReviewGroup, CaptureReviewRow } from '@/components/templates/capture/CaptureReviewGroup'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field } from '@/components/ui/field'
import { formatBytes } from '@/lib/files/format'
import { ChevronRight, FolderIcon, Package, ShieldAlertIcon, ShieldCheck, WrenchIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { DesktopCaptureFileTree } from './DesktopCaptureFileTree'
import { DesktopTemplateSetupFields } from './DesktopTemplateSetupFields'
import type { DesktopAgentCapturePlan, DesktopTemplateSetup } from './types'

export function DesktopCaptureReviewStep({ flow }: { flow: import('./useDesktopCaptureFlow').DesktopCaptureFlow }) {
    return <div className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">{flow.approvedCount} of {flow.plans.length} coworker{flow.plans.length === 1 ? '' : 's'} reviewed</p>
        <p className="text-xs text-amber-500">Saved logins, chats and memories are excluded. Private information in selected files and instructions is not automatically removed; review it before capturing.</p>
        <p className="text-xs text-muted-foreground">Binary files are copied byte-for-byte and are not text-scanned for secrets. Connector and system skills stay out unless trusted ownership marks them as user-authored.</p>
        {flow.plans.map(plan => <DesktopCaptureAgentReview
            key={plan.agentRowId}
            plan={plan}
            excluded={flow.excluded[plan.agentRowId] ?? []}
            approved={flow.approved[plan.agentRowId] ?? false}
            setup={flow.setups[plan.agentRowId] ?? { required: null, prompt: '' }}
            soloAgent={flow.plans.length === 1}
            disabled={flow.locked}
            onToggleFiles={(paths, keep) => flow.toggleFiles(plan.agentRowId, paths, keep)}
            onApprove={next => flow.setApproval(plan.agentRowId, next)}
            onSetupChange={next => flow.setSetup(plan.agentRowId, next)}
        />)}
    </div>
}

function DesktopCaptureAgentReview({ plan, excluded, approved, setup, soloAgent, disabled, onToggleFiles, onApprove, onSetupChange }: {
    plan: DesktopAgentCapturePlan
    excluded: string[]
    approved: boolean
    setup: DesktopTemplateSetup
    soloAgent: boolean
    disabled: boolean
    onToggleFiles: (paths: string[], keep: boolean) => void
    onApprove: (next: boolean) => void
    onSetupChange: (next: DesktopTemplateSetup) => void
}) {
    const kept = plan.files.filter(file => !excluded.includes(file.path))
    const flagged = kept.filter(file => file.flagged.length > 0)
    const [filesOpen, setFilesOpen] = useState(plan.exclusions.length > 0 || plan.unsupportedEntries.length > 0 || soloAgent)
    const keptBytes = kept.reduce((sum, file) => sum + file.bytes, 0)

    return <section className={cn('flex flex-col gap-3 overflow-hidden rounded-lg border bg-card p-3', approved ? 'border-primary/40' : 'border-border/60')}>
        <div className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium">{plan.displayName || plan.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{kept.length} of {plan.files.length} files, {formatBytes(keptBytes)}</span>
            </div>
            <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                {plan.name && <span className="shrink-0">@{plan.name}</span>}
                {plan.description && <span className="truncate">{plan.description}</span>}
            </span>
        </div>

        {plan.blocked && <p role="alert" className="text-xs text-destructive">{plan.blocked}</p>}
        {plan.included?.map(file => <details key={file.path} className="rounded border border-border/60 p-2">
            <summary className="cursor-pointer text-xs">{file.path} · included</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{file.text}</pre>
        </details>)}

        {plan.skills.length > 0 && <CaptureReviewGroup icon={Package} title="Skills">
            <CaptureReviewRow label="Skills"><CaptureReviewChips items={plan.skills.map(skill => skill.name)} max={6} /></CaptureReviewRow>
        </CaptureReviewGroup>}

        {plan.exclusions.length > 0 && <CaptureReviewGroup icon={ShieldCheck} title="Excluded from capture">
            {plan.exclusions.map(item => <IssueRow key={`${item.path}:${item.reason}`} path={item.path} reason={item.reason} />)}
        </CaptureReviewGroup>}

        {plan.unsupportedEntries.length > 0 && <CaptureReviewGroup icon={ShieldAlertIcon} title="Not included" tone="warning">
            {plan.unsupportedEntries.map(item => <IssueRow key={`${item.path}:${item.reason}`} path={item.path} reason={item.reason} />)}
        </CaptureReviewGroup>}

        {flagged.length > 0 && <CaptureReviewGroup icon={ShieldAlertIcon} title="Flagged files" tone="danger">
            <p className="text-xs text-destructive">{flagged.length} selected file{flagged.length === 1 ? '' : 's'} may contain private information and will be included in the template.</p>
            <CaptureReviewChips items={flagged.map(file => file.path)} mono max={5} />
        </CaptureReviewGroup>}

        <CaptureReviewGroup icon={WrenchIcon} title="Install">
            <DesktopTemplateSetupFields value={setup} disabled={disabled} onChange={next => {
                onSetupChange(next)
                if (next.required !== setup.required) onApprove(false)
            }} />
        </CaptureReviewGroup>

        <Collapsible open={filesOpen} onOpenChange={setFilesOpen}>
            <CaptureReviewGroup icon={FolderIcon} title="Files">
                <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded py-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
                    <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                    {filesOpen ? 'Hide the folder' : 'Show the folder'}
                    <span className="ml-auto">{kept.length} of {plan.files.length} kept</span>
                </CollapsibleTrigger>
                <CollapsibleContent><DesktopCaptureFileTree files={plan.files} excluded={excluded} disabled={disabled} onToggle={onToggleFiles} /></CollapsibleContent>
            </CaptureReviewGroup>
        </Collapsible>

        <div className="relative -mx-3 -mb-3 mt-auto border-t border-border/60 bg-amber-500/[0.02] px-3 py-2.5">
            <Field
                orientation="row"
                label="I reviewed what this coworker carries"
                helperText={!isSetupAnswered(setup) ? 'Answer the install question and write any required instructions first.' : flagged.length > 0 ? `${flagged.length} flagged file(s) will be included in the template.` : 'I also reviewed any private information in the selected content.'}
            >
                <Checkbox size="sm" disabled={disabled || !!plan.blocked || !isSetupAnswered(setup)} checked={approved} onCheckedChange={value => onApprove(value === true)} />
            </Field>
        </div>
    </section>
}

function IssueRow({ path, reason }: { path: string; reason: string }) {
    return <div className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 break-all font-mono text-foreground/80">{path}</span>
        <span className="min-w-0 flex-1 text-muted-foreground">{reason}</span>
    </div>
}
