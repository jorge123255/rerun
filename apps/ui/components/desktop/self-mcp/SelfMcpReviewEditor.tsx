'use client'
import type { SelfMcpDecisionOutcome, SelfMcpReviewSnapshot, SelfMcpTransport } from '@rerun/contracts'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { PanelEditorBody, PanelEditorFooter, PanelEditorHeader, PanelEditorShell } from '@/components/ui/panel-editor'
import { cn } from '@/lib/utils'

const TRANSPORTS: SelfMcpTransport[] = ['stdio', 'sse', 'http']

const CONNECTIVITY_LABELS: Record<SelfMcpReviewSnapshot['connectivity'], string> = {
    connected: 'Connected',
    needs_credentials: 'Needs credentials',
    needs_permission: 'Needs permission',
    unverified: 'Not verified yet',
}

const pairsText = (pairs: Record<string, string>) => Object.entries(pairs).map(([key, value]) => `${key}=${value}`).join('\n')

/**
 * Read-only review of a proposed MCP server. Field ordering mirrors the
 * original McpServerEditor: Name → Transport → Command/URL → Arguments →
 * Environment → Headers. The candidate is never editable here — the model's
 * proposal is frozen; the human only approves, rejects or cancels it, and the
 * server decides. Requirements and replacement conflicts are visible, never
 * silently enabled.
 */
export function SelfMcpReviewEditor({
    snapshot,
    busy,
    error,
    onBack,
    onDecide,
    onDismiss,
}: {
    snapshot: SelfMcpReviewSnapshot
    busy: boolean
    error: string
    onBack: () => void
    onDecide: (outcome: SelfMcpDecisionOutcome) => void
    onDismiss: () => void
}) {
    const { proposal, connectivity, requirements, conflict, alreadyConfigured } = snapshot
    const input = proposal.input
    const isStdio = proposal.transport === 'stdio'
    return (
        <PanelEditorShell>
            <PanelEditorHeader title={`Review MCP proposal · ${input.name}`} onBack={busy ? undefined : onBack} />
            <PanelEditorBody>
                {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                <p className="text-xs text-muted-foreground">Status: {proposal.status} · Connectivity: {CONNECTIVITY_LABELS[connectivity]}</p>
                {alreadyConfigured && <p className="text-xs text-muted-foreground">This exact server is already saved in the trusted configuration.</p>}
                {conflict?.existing && <p className="text-xs text-destructive">A server named “{input.name}” is already configured{conflict.replaces ? ` (${conflict.replaces})` : ''}; approving replaces it.</p>}
                {conflict?.managed && <p className="text-xs text-destructive">This server name is managed by a connected app/service and cannot be replaced by a proposal.</p>}
                {requirements.map(requirement => <p key={requirement} role="alert" className="text-xs text-amber-600">{requirement}</p>)}
                <Field label="Name" helperText={`Tools are merged as "${input.name}_<tool>".`}>
                    <Input disabled value={input.name} />
                </Field>
                <Field label="Transport">
                    <div className="flex gap-1.5">
                        {TRANSPORTS.map(transport => (
                            <span key={transport} className={cn('px-2 py-1 rounded-md text-xs border', proposal.transport === transport ? 'bg-accent border-foreground/30' : 'border-border opacity-60')}>
                                {transport}
                            </span>
                        ))}
                    </div>
                </Field>
                {isStdio ? (
                    <>
                        <Field label="Command">
                            <Input disabled value={input.command ?? ''} className="font-mono" />
                        </Field>
                        <Field label="Arguments" helperText="One argument per line.">
                            <Input disabled value={input.args.join('\n')} className="font-mono" />
                        </Field>
                    </>
                ) : (
                    <Field label="URL">
                        <Input disabled value={input.url ?? ''} className="font-mono" />
                    </Field>
                )}
                <Field label="Environment" helperText="One KEY=${NAME} reference per line; never an inline secret.">
                    <Input disabled value={pairsText(input.env)} className="font-mono" />
                </Field>
                <Field label="Headers" helperText="One Header=value per line; ${NAME} references to coworker variables.">
                    <Input disabled value={pairsText(input.headers)} className="font-mono" />
                </Field>
                <p className="text-xs text-muted-foreground">Nothing is saved, connected or executed until you approve it here, behind the existing MCP and local-program permissions.</p>
            </PanelEditorBody>
            <PanelEditorFooter>
                <Button disabled={busy || proposal.status !== 'pending' || requirements.length > 0 || !!conflict?.managed} onClick={() => onDecide({ kind: 'approved' })}>Approve and save</Button>
                <Button variant="outline" disabled={busy || proposal.status !== 'pending'} onClick={() => onDecide({ kind: 'rejected', reason: 'Not needed.' })}>Reject</Button>
                <Button variant="ghost" disabled={busy || proposal.status !== 'pending'} onClick={onDismiss}>Cancel proposal</Button>
            </PanelEditorFooter>
        </PanelEditorShell>
    )
}
