'use client'
import { useEffect, useRef, useState } from 'react'
import { ServiceFields } from '@/components/services/ServiceFields'
import { methodKindLabel } from '@/components/services/AuthMethodPicker'
import { Button } from '@/components/ui/button'
import { PanelSteps } from '@/components/ui/panel-steps'
import { ArrowLeftIcon } from '@/lib/icons'
import { serviceTransportSetupIntentSchema, serviceTransportRefSchema, type ServiceTransportRef, type ServiceTransportMethod, type ServiceTransportSetupIntent } from '@rerun/contracts'
import { ServiceTransportMethodPicker } from './ServiceTransportMethodPicker'
export type SetupAcknowledgement = { requestId: string; outcome: 'saved' | 'unknown' | 'refused'; ref?: ServiceTransportRef }
export type ServiceTransportSetupPorts = {
    journal: { read(ref: ServiceTransportRef): Promise<ServiceTransportSetupIntent | null>; put(intent: ServiceTransportSetupIntent): Promise<void>; clear(intent: ServiceTransportSetupIntent): Promise<void> }
    save(intent: ServiceTransportSetupIntent, values: Record<string, string>, signal: AbortSignal): Promise<SetupAcknowledgement>
    reconcile(intent: ServiceTransportSetupIntent, signal: AbortSignal): Promise<SetupAcknowledgement>
    uuid(): string
}
export type ServiceTransportSetupProps = { account: ServiceTransportRef; name: string; methods: ServiceTransportMethod[]; initialMethodId?: string; configuredInputs?: Record<string, true>; ports: ServiceTransportSetupPorts; onSaved(ref: ServiceTransportRef): void; onCancel(): void }
export function ServiceTransportSetup(props: ServiceTransportSetupProps) {
    return <Setup key={JSON.stringify(props.account)} {...props} />
}
function Setup({ account, name, methods, initialMethodId, configuredInputs = {}, ports, onSaved, onCancel }: ServiceTransportSetupProps) {
    const [methodId, setMethodId] = useState(initialMethodId ?? methods.find(m => m.recommended)?.id ?? methods[0]?.id)
    const method = methods.find(m => m.id === methodId), [choosing, choose] = useState(methods.length > 1 && !initialMethodId)
    const [values, setValues] = useState<Record<string, string>>({}), [pending, setPending] = useState<ServiceTransportSetupIntent | null>(null)
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [hydrated, setHydrated] = useState(false)
    const active = useRef(new AbortController()), sending = useRef(false)
    useEffect(() => {
        const controller = new AbortController(); active.current = controller
        void ports.journal.read(account).then(value => {
            if (controller.signal.aborted) return
            if (value) {
                const intent = serviceTransportSetupIntentSchema.parse(value)
                if (intent.ref.agentId !== account.agentId || intent.ref.installationId !== account.installationId || intent.ref.key !== account.key) throw new Error()
                setPending(intent)
            }
            setHydrated(true)
        }).catch(() => { if (!controller.signal.aborted) setError('Saved attempt unavailable. Reopen this account before continuing.') })
        return () => { controller.abort(); sending.current = false }
    }, [ports, account.agentId, account.installationId, account.revision, account.key])
    async function submit(reconcile: boolean) {
        if (sending.current || !method || !hydrated) return
        sending.current = true; setBusy(true); setError('')
        const signal = active.current.signal
        const intent = pending ?? serviceTransportSetupIntentSchema.parse({ ref: account, requestId: ports.uuid(), methodId: method.id })
        setPending(intent)
        try {
            await ports.journal.put(intent); signal.throwIfAborted()
            const result = reconcile ? await ports.reconcile(intent, signal) : await ports.save(intent, values, signal)
            signal.throwIfAborted(); setValues({})
            if (result.requestId !== intent.requestId) throw new Error()
            if (result.outcome === 'refused') {
                await ports.journal.clear(intent); signal.throwIfAborted(); setPending(null)
                setError('Configuration was not saved. Correct the setup and try again.')
                return
            }
            if (result.outcome !== 'saved' || !result.ref) throw new Error()
            const saved = serviceTransportRefSchema.parse(result.ref)
            if (saved.agentId !== account.agentId || saved.key !== account.key || saved.installationId !== account.installationId) throw new Error()
            await ports.journal.clear(intent); signal.throwIfAborted(); setPending(null); onSaved(saved)
        } catch { if (!signal.aborted) { setValues({}); setError('Configuration acknowledgement unavailable. Reconcile this same attempt; it will not be submitted automatically.') } }
        finally { sending.current = false; if (!signal.aborted) setBusy(false) }
    }
    return <div className="min-w-0 max-h-[70dvh] overflow-y-auto break-words">
        <PanelSteps stepKey={choosing ? 'methods' : methodId ?? 'missing'} depth={choosing ? 0 : 1}>
            {choosing ? <ServiceTransportMethodPicker methods={methods} onSelect={id => { setMethodId(id); setValues({}); choose(false); setError('') }} /> : <div className="space-y-3">
                <div className="flex min-w-0 items-center gap-1">
                    {methods.length > 1 && <Button size="icon-sm" variant="ghost" disabled={busy || !!pending} aria-label="Back to methods" onClick={() => choose(true)}><ArrowLeftIcon className="size-4" /></Button>}
                    <p className="min-w-0 truncate text-sm font-medium">{method ? method.label || methodKindLabel(method.kind) : 'Authentication'}</p>
                </div>
                {method && <fieldset disabled={!hydrated || busy || !!pending} className="min-w-0 space-y-2">
                    <ServiceFields inputs={method.kind === 'oauth' ? method.inputs.filter(i => !i.secret) : method.inputs} values={values} onChange={(key, value) => setValues(current => ({ ...current, [key]: value }))} />
                    {method.inputs.some(i => i.secret && configuredInputs[i.key]) && <p className="text-xs text-muted-foreground">Leave configured credentials blank to keep this account’s saved values.</p>}
                </fieldset>}
                {method?.availability === 'unsupported' && <p className="text-xs text-muted-foreground">This method is not available locally.</p>}
                {method?.transport === 'stdio' && <p className="text-xs text-muted-foreground">Requires an approved installed program and local-program permission. Saving setup does not start it.</p>}
                {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => { active.current.abort(); setValues({}); onCancel() }}>Cancel</Button>
                    {pending ? <Button size="sm" disabled={busy || !hydrated} onClick={() => void submit(true)}>Reconcile</Button>
                        : <Button size="sm" disabled={!hydrated || busy || !method || method.availability === 'unsupported' || method.inputs.some(i => i.required && !values[i.key]?.trim() && !(i.secret && configuredInputs[i.key]))} onClick={() => void submit(false)}>{busy ? 'Installing…' : method?.kind === 'oauth' ? 'Connect' : 'Install'}</Button>}
                </div>
                <p className="text-xs text-muted-foreground">{name} is usable after an explicit connection check with current permission.</p>
            </div>}
        </PanelSteps>
    </div>
}
