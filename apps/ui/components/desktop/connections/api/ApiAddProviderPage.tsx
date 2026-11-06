'use client'
import { ProviderHeader } from '@/components/connections/SourceBits'
import { CredentialGuide } from '@/components/services/CredentialGuide'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PanelScroller } from '@/components/ui/panel-list'
import { PROVIDER_GUIDE, PROVIDER_PITCH, suggestName } from '@/lib/engine/ai-sources'
import { DEFAULT_CONNECTION_MODELS, desktopApiCreateInputSchema, type DesktopApiConnectionProvider } from '@rerun/contracts'
import { ApiConnectionsSession } from '@/lib/desktop/api-connections/session'

export function ApiAddProviderPage({ provider, session }: { provider: DesktopApiConnectionProvider; session: ApiConnectionsSession }) {
    const state = session.snapshot(), key = `add:${provider}`
    const draft = session.draft(key, { name: suggestName(provider, state.catalog?.connections.map(c => c.name) ?? []) })
    const input = { workspaceId: session.workspaceId, provider, name: draft.name,
        secret: draft.secret, models: DEFAULT_CONNECTION_MODELS[provider], extraModels: [] }
    const valid = desktopApiCreateInputSchema.omit({ requestId: true }).safeParse(input).success
    return <div className="flex min-h-0 flex-1 flex-col">
        <ProviderHeader provider={provider} onBack={() => session.navigate({ kind: 'list' })} />
        <PanelScroller className="space-y-4 p-4">
            <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (valid) void session.execute({ kind: 'create', input: desktopApiCreateInputSchema.parse({ ...input, requestId: crypto.randomUUID() }) }) }}>
                <fieldset disabled={state.busy || !!state.uncertain} className="min-w-0 space-y-4">
                    <Input autoFocus label="Name" maxLength={120} value={draft.name} onChange={event => session.changeDraft(key, { name: event.target.value })} helperText="Shown in every coworker's model picker" className="h-8" />
                    <Input hideRequired label="API key" type="password" autoComplete="new-password" spellCheck={false} maxLength={4096} value={draft.secret} onChange={event => session.changeDraft(key, { secret: event.target.value })} placeholder="Paste your key" className="h-8 font-mono text-xs" />
                    <CredentialGuide label={PROVIDER_PITCH[provider].title} title={PROVIDER_GUIDE[provider].title} guide={PROVIDER_GUIDE[provider].steps} />
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button type="button" size="sm" variant="ghost" onClick={() => session.navigate({ kind: 'list' })}>Cancel</Button>
                        <Button type="submit" size="sm" disabled={!valid}>{state.busy ? 'Connecting…' : 'Add key'}</Button>
                    </div>
                </fieldset>
            </form>
        </PanelScroller>
    </div>
}
