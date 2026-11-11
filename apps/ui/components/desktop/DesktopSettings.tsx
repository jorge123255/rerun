import { useDesktopLocale } from './DesktopLocale'
import { flushDesktopWorkspaceMetadata } from '@/lib/desktop/workspaces/metadata'
import { useMemo, useState, type FormEvent } from 'react'
import { CONNECTION_TOKEN_KEY, DEFAULT_CONNECTION_MODELS, PROVIDER_LABELS, connectionReasoningOptions, isDesktopSubscriptionProvider, type ConnectionsList } from '@rerun/contracts'
import { ThemeToggle } from '@rerun/ui/theme'
import { DesktopLanguageSettings } from './DesktopLanguageSettings'
import { DesktopCodexLogin } from './DesktopCodexLogin'
import { DesktopSubscriptionLogin } from './DesktopSubscriptionLogin'
import { DesktopPlanLimitsBlock } from './usage/DesktopPlanLimitsBlock'
import { DesktopClaudeLogin } from './claude-plan/DesktopClaudeLogin'
import { DesktopNotificationSettings } from './DesktopNotificationSettings'
import { DesktopAuxiliarySettings } from './DesktopAuxiliarySettings'
import { BaseUrlField } from '@/components/connections/BaseUrlField'
import { CustomModelList } from '@/components/connections/CustomModelList'
import { ModelBuckets } from '@/components/connections/ModelBuckets'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { enabledModels, modelName } from '@/lib/engine/ai-sources'
import { ProviderIcon } from '@/lib/engine/provider-icons'
import { WORKSPACE_NAME_MAX } from '@/lib/naming/workspace-name'
import { desktopProvider, type SettingsChange } from '@/lib/desktop/settings'
import { customReasoningUnavailable } from '@/lib/desktop/chat-model'
import { DesktopCustomProviderPage } from './connections/custom/DesktopCustomProviderPage'
import { ApiConnectionsPanel } from './connections/api/ApiConnectionsPanel'
import { createApiConnectionsClient } from '@/lib/desktop/api-connections/client'
import { desktopApiConnectionUiRoutes } from '@/lib/desktop/api-connections/routes'

type Props = {
    initialTab?: 'AI providers' | 'Tool services' | 'Workspace' | 'Notifications' | 'Shortcuts'
    providers: ConnectionsList
    workspaceName: string
    onProviders: (providers: ConnectionsList) => void
    onSave: (change: SettingsChange) => Promise<void>
    workspaceId?: number | null
    onConnectionsChanged?: () => void
}

const selectClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm'
const panels = ['AI providers', 'Tool services', 'Workspace', 'Notifications', 'Shortcuts'] as const
function effortLabel(effort: string) {
    return effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function DesktopSettings({ providers, workspaceName, onSave, onProviders, initialTab, workspaceId = null, onConnectionsChanged }: Props) {
    const { t } = useDesktopLocale()
    const apiConnections = useMemo(() => Number.isSafeInteger(workspaceId) && (workspaceId ?? 0) > 0 ? createApiConnectionsClient(desktopApiConnectionUiRoutes) : null, [workspaceId])
    const labels = { 'AI providers': t('providers'), 'Tool services': t('toolServices'), Workspace: t('workspace'), Notifications: t('notifications'), Shortcuts: t('shortcuts') }
    const [tab, setTab] = useState<typeof panels[number]>(initialTab ?? 'AI providers')
    const [source, setSource] = useState(providers.connections.find(c => c.id === providers.default?.connectionId)?.id ?? providers.connections[0]?.id ?? 'add:openai')
    const [key, setKey] = useState('')
    const [name, setName] = useState(workspaceName)
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const [error, setError] = useState('')
    const editable = providers.connections.filter(c => !isDesktopSubscriptionProvider(c.provider))
    const current = editable.find(c => c.id === source)
    const provider = current ? desktopProvider.parse(current.provider) : desktopProvider.safeParse(source.replace(/^add:/, '')).data ?? 'openai'
    const missing = desktopProvider.options.filter(p => p !== 'custom' && !isDesktopSubscriptionProvider(p) && !editable.some(c => c.provider === p))
    const picks = providers.connections.filter(c => c.connected && !(c.provider === 'claude' && c.credentialRejected)).flatMap(c => enabledModels(c).map(m => ({ connectionId: c.id, model: m.id })))
    const selected = picks.findIndex(p => p.connectionId === providers.default?.connectionId && p.model === providers.default.model)
    const active = providers.default
    const activeConnection = providers.connections.find(c => c.id === active?.connectionId && c.connected)
    const reasoning = active && activeConnection ? connectionReasoningOptions(activeConnection, active.model) : undefined
    const staleEffort = customReasoningUnavailable(activeConnection ?? null, active?.model ?? null, active)

    async function save(change: SettingsChange, message: string) {
        setBusy(true)
        setNotice('')
        setError('')
        try {
            await onSave(change)
            if (change.action === 'workspace') await flushDesktopWorkspaceMetadata().catch(() => {})
            if (change.action === 'key') setKey('')
            setNotice(message)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not save settings.')
        } finally {
            setBusy(false)
        }
    }

    function saveKey(event: FormEvent) {
        event.preventDefault()
        if (key.trim() && provider !== 'codex' && provider !== 'claude' && provider !== 'custom' && !isDesktopSubscriptionProvider(provider)) void save({ action: 'key', provider, connectionId: current?.id, apiKey: key.trim() }, 'API key saved.')
    }

    // A provider that was just added replaces its "add" option with the engine connection.
    const connection = current ?? (provider === 'custom' ? undefined : providers.connections.find(c => c.provider === provider))
    const changeModels = (models: string[], extraModels: string[]) => {
        if (connection) void save({ action: 'models', connectionId: connection.id, models, extraModels }, 'Available models updated.')
    }

    return (
        <section className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8">
                <header>
                    <h1 className="text-2xl font-semibold tracking-tight">{t('settings')}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{workspaceName}</p>
                </header>
                <nav aria-label={t('settingsSections')} className="flex flex-wrap gap-2 border-b pb-3">
                    {panels.map(panel => <Button key={panel} size="sm" variant={tab === panel ? 'secondary' : 'ghost'} disabled={busy} aria-current={tab === panel ? 'page' : undefined} onClick={() => {
                        setTab(panel); setNotice(''); setError(''); setKey('')
                    }}>{labels[panel]}</Button>)}
                </nav>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
                <fieldset disabled={busy} className="min-w-0 space-y-5">
                    {tab === 'AI providers' && <>
                        <div className="space-y-2 rounded-xl border p-4">
                            <label htmlFor="desktop-default" className="font-semibold">{t('defaultModel')}</label>
                            <p className="text-sm text-muted-foreground">Used for the next message to any coworker, including in existing conversations.</p>
                            <select id="desktop-default" className={selectClass} disabled={!picks.length} value={selected} onChange={e => {
                                const pick = picks[Number(e.target.value)]
                                if (pick) void save({ action: 'default', ...pick }, 'Default model saved.')
                            }}>
                                {selected < 0 && <option value={-1} disabled>{picks.length ? 'Choose a model' : 'Connect a provider to choose a model'}</option>}
                                {providers.connections.filter(c => c.connected && !(c.provider === 'claude' && c.credentialRejected)).map(c => <optgroup key={c.id} label={c.name}>{picks.map((p, index) => p.connectionId === c.id &&
                                    <option key={p.model} value={index}>{c.subscriptionModels?.find(m => m.id === p.model)?.label ?? modelName(c.id, p.model)}</option>)}</optgroup>)}
                            </select>
                            {activeConnection && active && (activeConnection.provider === 'codex' || reasoning || staleEffort) && <div className="space-y-2 pt-3">
                                <label htmlFor="desktop-reasoning-effort" className="font-semibold">Reasoning effort</label>
                                <p id="desktop-reasoning-hint" className="text-sm text-muted-foreground">How much reasoning {activeConnection.provider === 'codex' ? 'Codex' : activeConnection.name} uses for the next message.</p>
                                <select id="desktop-reasoning-effort" aria-describedby="desktop-reasoning-hint" className={selectClass}
                                    disabled={!reasoning?.supported.length && !staleEffort}
                                    value={staleEffort ? 'unavailable' : active.reasoningEffort && reasoning?.supported.includes(active.reasoningEffort) ? active.reasoningEffort : ''}
                                    onChange={e => void save({ action: 'default', connectionId: activeConnection.id, model: active.model, reasoningEffort: e.target.value || null,
                                        ...(activeConnection.provider === 'custom' && { customReasoningRevision: activeConnection.customRevision }) }, 'Reasoning effort saved.')}>
                                    {staleEffort && <option value="unavailable" disabled>Saved effort unavailable</option>}
                                    <option value="">Model default{reasoning?.default ? ` (${effortLabel(reasoning.default)})` : ''}</option>
                                    {reasoning?.supported.map(level => <option key={level} value={level}>{effortLabel(level)}</option>)}
                                </select>
                            </div>}
                        </div>
                        {apiConnections && workspaceId ? <div className="flex min-h-64 min-w-0 flex-col overflow-hidden rounded-xl border">
                            <ApiConnectionsPanel workspaceId={workspaceId} currentWorkspace={() => workspaceId} active api={apiConnections} selectionContext={null} onCatalog={() => onConnectionsChanged?.()} />
                        </div> : <p role="status" className="text-sm text-muted-foreground">Named API-key connections stay unavailable until this workspace identity is confirmed. Choosing a default model here stays on the existing Settings authority.</p>}
                        <div className="space-y-4 rounded-xl border p-4">
                            <label htmlFor="desktop-provider" className="font-semibold">Provider connection</label>
                            <select id="desktop-provider" className={selectClass} value={connection?.id ?? 'add:' + provider} onChange={e => {
                                setSource(e.target.value); setKey(''); setNotice(''); setError('')
                            }}>
                                {editable.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                {workspaceId && <option value="add:custom">Add custom endpoint</option>}
                                {missing.map(p => <option key={p} value={'add:' + p}>Connect {p === 'codex' ? 'ChatGPT (Codex)' : PROVIDER_LABELS[p]}</option>)}
                            </select>
                            <div className="flex items-center gap-2 text-sm"><ProviderIcon provider={provider} className="size-5" /><strong>{provider === 'codex' ? 'ChatGPT (Codex)' : PROVIDER_LABELS[provider]}</strong>
                                {provider !== 'codex' && provider !== 'claude' && provider !== 'custom' && <span className="text-muted-foreground">{connection?.credentialRejected ? 'Key rejected' : connection?.connected ? 'Key saved' : 'No key saved'}</span>}
                            </div>
                            {provider === 'custom' ? workspaceId && (connection === undefined || connection.customRevision) ? <DesktopCustomProviderPage
                                key={connection?.id ?? 'new-custom'}
                                workspaceId={workspaceId}
                                identity={connection?.customRevision ? { workspaceId, connectionId: connection.id, revision: connection.customRevision } : null}
                                takenNames={providers.connections.filter(item => item.id !== connection?.id).map(item => item.name)}
                                defaultModel={providers.default}
                                onBack={() => setSource(providers.connections.find(item => item.provider !== 'custom')?.id ?? 'add:openai')}
                                onReceipt={receipt => { if (receipt.status === 'recorded') onConnectionsChanged?.() }}
                                onCatalogChanged={onConnectionsChanged}
                            /> : <p role="status">Custom endpoint settings are unavailable.</p> : provider === 'codex' ? <>
                                <DesktopCodexLogin connected={!!connection?.connected} modelCount={connection?.models.length ?? 0} onProviders={onProviders} />
                                {connection?.provider === 'codex' && connection.connected && <DesktopPlanLimitsBlock connection={connection} />}
                            </> : provider === 'claude' ? <DesktopClaudeLogin connected={!!connection?.connected} rejected={connection?.credentialRejected} onProviders={onProviders} /> : <form onSubmit={saveKey} className="space-y-2">
                                <label htmlFor="desktop-api-key" className="text-sm font-medium">{connection ? 'Replacement API key' : 'API key'}</label>
                                <div className="flex gap-2">
                                    <Input id="desktop-api-key" type="password" autoComplete="off" placeholder={CONNECTION_TOKEN_KEY[provider]} value={key} onChange={e => setKey(e.target.value)} />
                                    <Button type="submit" disabled={busy || !key.trim()}>{connection ? 'Save key' : 'Connect'}</Button>
                                </div>
                            </form>}
                            {provider !== 'codex' && provider !== 'custom' && connection && <div inert={busy}>
                                <ModelBuckets connection={connection} defaultModel={providers.default?.connectionId === connection.id ? providers.default.model : null}
                                    onModelsChange={models => changeModels(models, connection.extraModels)} />
                                {provider === 'openrouter' && <BaseUrlField key={connection.id + ':' + (connection.baseUrl ?? '')} baseUrl={connection.baseUrl ?? ''}
                                    onCommit={baseUrl => void save({ action: 'endpoint', connectionId: connection.id, baseUrl }, 'Endpoint updated.')} />}
                                {provider === 'openrouter' && <CustomModelList models={connection.extraModels} reserved={DEFAULT_CONNECTION_MODELS.openrouter} onChange={extras => changeModels(connection.models, extras)} />}
                            </div>}
                        </div>
                        <DesktopSubscriptionLogin key={workspaceId ?? 'workspace'} onConnectionsChanged={onConnectionsChanged} />
                        <p className="text-sm text-muted-foreground">Connect ChatGPT (Codex) or Claude with your subscription, or use an API key for the other providers.</p>
                    </>}
                    {tab === 'Workspace' && <>
                        <DesktopLanguageSettings />
                        <form className="space-y-2 rounded-xl border p-4" onSubmit={e => {
                            e.preventDefault(); void save({ action: 'workspace', name: name.trim() }, 'Workspace name saved.')
                        }}>
                            <label htmlFor="workspace-name" className="font-semibold">{t('workspaceName')}</label>
                            <Input id="workspace-name" maxLength={WORKSPACE_NAME_MAX} value={name} onChange={e => setName(e.target.value)} />
                            <Button disabled={!name.trim() || name.trim() === workspaceName} type="submit">{t('saveName')}</Button>
                        </form>
                        <div className="flex items-center justify-between rounded-xl border p-4"><strong>{t('appearance')}</strong><ThemeToggle onPreferenceChange={theme => void save({ action: 'appearance', theme }, 'Appearance saved.')} /></div>
                    </>}
                    {tab === 'Shortcuts' && <dl className="grid grid-cols-[1fr_auto] gap-3 rounded-xl border p-4 text-sm">
                        <dt>Open Settings</dt><dd>⌘ ,</dd><dt>Send a chat message</dt><dd>Return</dd><dt>New line in chat</dt><dd>Shift Return</dd>
                        <dt>Open a focused coworker</dt><dd>Return or Space</dd>
                    </dl>}
                    {tab === 'Notifications' && <DesktopNotificationSettings />}
                    {tab === 'Tool services' && <DesktopAuxiliarySettings />}
                </fieldset>
            </div>
        </section>
    )
}
