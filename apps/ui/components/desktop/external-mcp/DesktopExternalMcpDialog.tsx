'use client'

import { useMemo, type ReactNode } from 'react'
import { EXTERNAL_MCP_COPY, type ExternalMcpScope } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { DocsLink } from '@/components/ui/docs-link'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { SkeletonList } from '@/components/ui/skeleton'
import { Loader2Icon, KeyIcon } from '@/lib/icons'
import { createDesktopExternalMcpDriver } from '@/lib/desktop/external-mcp/client'
import type { DesktopExternalMcpDriver } from '@/lib/desktop/external-mcp/driver'
import { externalMcpEndpoint } from '@/lib/desktop/external-mcp/snippets'
import { ScrollFade } from '@rerun/ui/primitives'
import { DesktopCreatedExternalMcpKey } from './DesktopCreatedExternalMcpKey'
import { DesktopExternalMcpKeyList } from './DesktopExternalMcpKeyList'
import { DesktopExternalMcpSnippets } from './DesktopExternalMcpSnippets'
import { DesktopRevokeExternalMcpKeyDialog } from './DesktopRevokeExternalMcpKeyDialog'
import { useDesktopExternalMcpController } from './useDesktopExternalMcpController'

function SectionTitle({ children, action }: { children: string; action?: ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-3 px-1">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{children}</h3>
            {action}
        </div>
    )
}

export function DesktopExternalMcpDialog({ open, onOpenChange, workspaceId, driver: suppliedDriver }: { open: boolean; onOpenChange: (open: boolean) => void; workspaceId: number; driver?: DesktopExternalMcpDriver }) {
    const fallback = useMemo(() => createDesktopExternalMcpDriver(workspaceId), [workspaceId])
    const driver = suppliedDriver ?? fallback
    return <DialogFrame key={workspaceId} open={open} onOpenChange={onOpenChange} workspaceId={workspaceId} driver={driver} />
}

function DialogFrame({ open, onOpenChange, workspaceId, driver }: { open: boolean; onOpenChange: (open: boolean) => void; workspaceId: number; driver: DesktopExternalMcpDriver }) {
    const controller = useDesktopExternalMcpController({ workspaceId, open, driver })
    const endpoint = controller.listener ? externalMcpEndpoint(controller.listener) : null
    const pendingListenerKind = controller.pendingListener?.kind
    const change = (next: boolean) => {
        if (!next) controller.dismissSecret()
        onOpenChange(next)
    }
    const toggleScope = (scope: ExternalMcpScope) => {
        if (scope === 'mcp:read') return
        controller.setScopes(current => current.includes(scope) ? current.filter(item => item !== scope) : [...current, scope])
    }

    return (
        <Dialog open={open} onOpenChange={change}>
            <DialogContent className="flex flex-col sm:max-h-[85dvh] sm:max-w-lg sm:overflow-hidden">
                <DialogHeaderBar icon={KeyIcon} title={EXTERNAL_MCP_COPY.dialogTitle} description={EXTERNAL_MCP_COPY.dialogBody} />

                <ScrollFade className="-mx-1 min-h-0 flex-1 px-1 py-1">
                    <div className="space-y-4">
                        {controller.loading ? <SkeletonList rows={3} /> : (
                            <>
                                <section className="min-w-0 space-y-2">
                                    <SectionTitle>{EXTERNAL_MCP_COPY.sectionConnect}</SectionTitle>
                                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2.5">
                                        <span className="min-w-0 break-all text-xs text-muted-foreground">{endpoint ?? EXTERNAL_MCP_COPY.listenerOff}</span>
                                        <Button type="button" size="sm" variant="outline" disabled={controller.listenerBusy || !controller.listener} onClick={() => controller.configureListener(pendingListenerKind ?? (endpoint ? 'disable' : 'enable'))}>
                                            {controller.listenerBusy && <Loader2Icon className="animate-spin" />}
                                            {pendingListenerKind ? 'Retry request' : endpoint ? 'Disable local listener' : 'Enable local listener'}
                                        </Button>
                                    </div>
                                    {controller.createdSecret ? (
                                        <DesktopCreatedExternalMcpKey value={controller.createdSecret} mcpUrl={endpoint} onDismiss={controller.dismissSecret} />
                                    ) : endpoint ? <DesktopExternalMcpSnippets mcpUrl={endpoint} /> : null}
                                </section>

                                <section className="min-w-0 space-y-2">
                                    <SectionTitle action={<DocsLink path="/api/authentication">{EXTERNAL_MCP_COPY.docsLabel}</DocsLink>}>{EXTERNAL_MCP_COPY.sectionKeys}</SectionTitle>
                                    <DesktopExternalMcpKeyList keys={controller.keys} busy={controller.revokeBusy} pendingKeyIds={controller.pendingRevokes} onRevoke={controller.startRevoke} />

                                    <Input
                                        label={EXTERNAL_MCP_COPY.nameLabel}
                                        placeholder={EXTERNAL_MCP_COPY.namePlaceholder}
                                        value={controller.draft}
                                        disabled={controller.creating || !!controller.pendingCreate}
                                        onChange={event => controller.setDraft(event.target.value)}
                                        onKeyDown={event => {
                                            if (event.key === 'Enter') {
                                                event.preventDefault()
                                                controller.create()
                                            }
                                        }}
                                    />
                                    <Field label="Access" helperText="Read-only is the default. Select only the additional writes this client needs.">
                                        <div className="flex flex-wrap gap-x-3 gap-y-2">
                                            {controller.scopeOptions.map(scope => (
                                                <label key={scope} className="flex items-center gap-1.5 text-xs">
                                                    <input
                                                        type="checkbox"
                                                        checked={scope === 'mcp:read' || controller.scopes.includes(scope)}
                                                        disabled={scope === 'mcp:read' || controller.creating || !!controller.pendingCreate}
                                                        onChange={() => toggleScope(scope)}
                                                    />
                                                    {scope}
                                                </label>
                                            ))}
                                        </div>
                                    </Field>
                                    <Input
                                        label="Expires at (optional)"
                                        type="datetime-local"
                                        value={controller.expiresInput}
                                        disabled={controller.creating || !!controller.pendingCreate}
                                        onChange={event => controller.setExpiresInput(event.target.value)}
                                    />
                                    <div className="flex justify-end">
                                        <Button type="button" onClick={controller.create} disabled={controller.creating || (!controller.pendingCreate && !controller.draft.trim())}>
                                            {controller.creating && <Loader2Icon className="animate-spin" />}
                                            {controller.pendingCreate ? 'Retry request' : EXTERNAL_MCP_COPY.create}
                                        </Button>
                                    </div>
                                </section>
                            </>
                        )}
                        {controller.error && (
                            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                                <span className="min-w-0 break-words">{controller.error}</span>
                                {!controller.pendingCreate && <Button type="button" size="sm" variant="ghost" onClick={controller.retryLoad}>Retry</Button>}
                            </div>
                        )}
                    </div>
                </ScrollFade>

                <DesktopRevokeExternalMcpKeyDialog apiKey={controller.revoking} pending={controller.revokeBusy} error={controller.revokeError} onOpenChange={next => { if (!next) controller.cancelRevoke() }} onConfirm={controller.revoke} />
            </DialogContent>
        </Dialog>
    )
}
