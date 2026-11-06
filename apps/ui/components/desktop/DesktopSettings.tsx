import { useState, type FormEvent } from 'react'
import { CONNECTION_TOKEN_KEY, DEFAULT_CONNECTION_MODELS, PROVIDER_LABELS, type ConnectionsList } from '@rerun/contracts'
import { ThemeToggle } from '@rerun/ui/theme'
import { DesktopCodexLogin } from './DesktopCodexLogin'
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

type Props = {
    providers: ConnectionsList
    workspaceName: string
    onProviders: (providers: ConnectionsList) => void
    onSave: (change: SettingsChange) => Promise<void>
}

const selectClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm'
const panels = ['AI providers', 'Tool services', 'Workspace', 'Notifications', 'Shortcuts'] as const
function effortLabel(effort: string) {
    return effort === 'xhigh' ? 'Extra high' : effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function DesktopSettings({ providers, workspaceName, onSave, onProviders }: Props) {
    const [tab, setTab] = useState<typeof panels[number]>('AI providers')
    const [source, setSource] = useState(providers.connections.find(c => c.id === providers.default?.connectionId)?.id ?? providers.connections[0]?.id ?? 'add:openai')
    const [key, setKey] = useState('')
    const [name, setName] = useState(workspaceName)
    const [busy, setBusy] = useState(false)
    const [notice, setNotice] = useState('')
    const [error, setError] = useState('')
    const current = providers.connections.find(c => c.id === source)
    const provider = current ? desktopProvider.parse(current.provider) : desktopProvider.parse(source.replace(/^add:/, ''))
    const missing = desktopProvider.options.filter(p => !providers.connections.some(c => c.provider === p))
    const picks = providers.connections.filter(c => c.connected).flatMap(c => enabledModels(c).map(m => ({ connectionId: c.id, model: m.id })))
    const selected = picks.findIndex(p => p.connectionId === providers.default?.connectionId && p.model === providers.default.model)
    const active = providers.default
    const codex = providers.connections.find(c => c.id === active?.connectionId && c.connected && c.provider === 'codex')
    const reasoning = active && codex?.codexReasoning?.[active.model]

    async function save(change: SettingsChange, message: string) {
        setBusy(true)
        setNotice('')
        setError('')
        try {
            await onSave(change)
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
        if (key.trim() && provider !== 'codex' && provider !== 'claude') void save({ action: 'key', provider, connectionId: current?.id, apiKey: key.trim() }, 'API key saved.')
    }

    // A provider that was just added replaces its "add" option with the engine connection.
    const connection = current ?? providers.connections.find(c => c.provider === provider)
    const changeModels = (models: string[], extraModels: string[]) => {
        if (connection) void save({ action: 'models', connectionId: connection.id, models, extraModels }, 'Available models updated.')
    }

    return (
        <section className="min-h-0 flex-1 overflow-auto">
            <div className="mx-auto max-w-3xl space-y-6 px-5 py-6 sm:px-8">
                <header>
                    <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
                    <p className="mt-1 text-sm text-muted-foreground">{workspaceName}</p>
                </header>
                <nav aria-label="Settings sections" className="flex flex-wrap gap-2 border-b pb-3">
                    {panels.map(panel => <Button key={panel} size="sm" variant={tab === panel ? 'secondary' : 'ghost'} disabled={busy} aria-current={tab === panel ? 'page' : undefined} onClick={() => {
                        setTab(panel); setNotice(''); setError(''); setKey('')
                    }}>{panel}</Button>)}
                </nav>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
                <fieldset disabled={busy} className="min-w-0 space-y-5">
                    {tab === 'AI providers' && <>
                        <div className="space-y-2 rounded-xl border p-4">
                            <label htmlFor="desktop-default" className="font-semibold">Default model</label>
                            <p className="text-sm text-muted-foreground">Used for the next message to any coworker, including in existing conversations.</p>
                            <select id="desktop-default" className={selectClass} disabled={!picks.length} value={selected} onChange={e => {
                                const pick = picks[Number(e.target.value)]
                                if (pick) void save({ action: 'default', ...pick }, 'Default model saved.')
                            }}>
                                {selected < 0 && <option value={-1} disabled>{picks.length ? 'Choose a model' : 'Connect a provider to choose a model'}</option>}
                                {providers.connections.filter(c => c.connected).map(c => <optgroup key={c.id} label={c.name}>{picks.map((p, index) => p.connectionId === c.id &&
                                    <option key={p.model} value={index}>{modelName(c.id, p.model)}</option>)}</optgroup>)}
                            </select>
                            {codex && active && <div className="space-y-2 pt-3">
                                <label htmlFor="desktop-reasoning-effort" className="font-semibold">Reasoning effort</label>
                                <p id="desktop-reasoning-hint" className="text-sm text-muted-foreground">How much reasoning Codex uses for the next message.</p>
                                <select id="desktop-reasoning-effort" aria-describedby="desktop-reasoning-hint" className={selectClass}
                                    disabled={!reasoning?.supported.length}
                                    value={active.reasoningEffort && reasoning?.supported.includes(active.reasoningEffort) ? active.reasoningEffort : ''}
                                    onChange={e => void save({ action: 'default', connectionId: codex.id, model: active.model, reasoningEffort: e.target.value || null }, 'Reasoning effort saved.')}>
                                    <option value="">Model default{reasoning?.default ? ` (${effortLabel(reasoning.default)})` : ''}</option>
                                    {reasoning?.supported.map(level => <option key={level} value={level}>{effortLabel(level)}</option>)}
                                </select>
                            </div>}
                        </div>
                        <div className="space-y-4 rounded-xl border p-4">
                            <label htmlFor="desktop-provider" className="font-semibold">Provider connection</label>
                            <select id="desktop-provider" className={selectClass} value={connection?.id ?? 'add:' + provider} onChange={e => {
                                setSource(e.target.value); setKey(''); setNotice(''); setError('')
                            }}>
                                {providers.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                                {missing.map(p => <option key={p} value={'add:' + p}>Connect {p === 'codex' ? 'ChatGPT (Codex)' : PROVIDER_LABELS[p]}</option>)}
                            </select>
                            <div className="flex items-center gap-2 text-sm"><ProviderIcon provider={provider} className="size-5" /><strong>{provider === 'codex' ? 'ChatGPT (Codex)' : PROVIDER_LABELS[provider]}</strong>
                                {provider !== 'codex' && provider !== 'claude' && <span className="text-muted-foreground">{connection?.credentialRejected ? 'Key rejected' : connection?.connected ? 'Key saved' : 'No key saved'}</span>}
                            </div>
                            {provider === 'codex' ? <DesktopCodexLogin connected={!!connection?.connected} modelCount={connection?.models.length ?? 0} onProviders={onProviders} /> : provider === 'claude' ? <DesktopClaudeLogin connected={!!connection?.connected} rejected={connection?.credentialRejected} onProviders={onProviders} /> : <form onSubmit={saveKey} className="space-y-2">
                                <label htmlFor="desktop-api-key" className="text-sm font-medium">{connection ? 'Replacement API key' : 'API key'}</label>
                                <div className="flex gap-2">
                                    <Input id="desktop-api-key" type="password" autoComplete="off" placeholder={CONNECTION_TOKEN_KEY[provider]} value={key} onChange={e => setKey(e.target.value)} />
                                    <Button type="submit" disabled={busy || !key.trim()}>{connection ? 'Save key' : 'Connect'}</Button>
                                </div>
                            </form>}
                            {provider !== 'codex' && connection && <div inert={busy}>
                                <ModelBuckets connection={connection} defaultModel={providers.default?.connectionId === connection.id ? providers.default.model : null}
                                    onModelsChange={models => changeModels(models, connection.extraModels)} />
                                {provider === 'openrouter' && <BaseUrlField key={connection.id + ':' + (connection.baseUrl ?? '')} baseUrl={connection.baseUrl ?? ''}
                                    onCommit={baseUrl => void save({ action: 'endpoint', connectionId: connection.id, baseUrl }, 'Endpoint updated.')} />}
                                {provider === 'openrouter' && <CustomModelList models={connection.extraModels} reserved={DEFAULT_CONNECTION_MODELS.openrouter} onChange={extras => changeModels(connection.models, extras)} />}
                            </div>}
                        </div>
                        <p className="text-sm text-muted-foreground">Connect ChatGPT (Codex) or Claude with your subscription, or use an API key for the other providers.</p>
                    </>}
                    {tab === 'Workspace' && <>
                        <form className="space-y-2 rounded-xl border p-4" onSubmit={e => {
                            e.preventDefault(); void save({ action: 'workspace', name: name.trim() }, 'Workspace name saved.')
                        }}>
                            <label htmlFor="workspace-name" className="font-semibold">Workspace name</label>
                            <Input id="workspace-name" maxLength={WORKSPACE_NAME_MAX} value={name} onChange={e => setName(e.target.value)} />
                            <Button disabled={!name.trim() || name.trim() === workspaceName} type="submit">Save name</Button>
                        </form>
                        <div className="flex items-center justify-between rounded-xl border p-4"><strong>Appearance</strong><ThemeToggle onPreferenceChange={theme => void save({ action: 'appearance', theme }, 'Appearance saved.')} /></div>
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
