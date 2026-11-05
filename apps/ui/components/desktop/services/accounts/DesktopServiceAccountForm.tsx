'use client'

import { useEffect, useRef, useState } from 'react'
import { AuthMethodPicker, methodKindLabel } from '@/components/services/AuthMethodPicker'
import { ServiceFields } from '@/components/services/ServiceFields'
import { Button } from '@/components/ui/button'
import type { InputDef } from '@/lib/services/manifest'
import type { DesktopServiceAccountView } from '../../../../../../packages/contracts/src/desktop-service-accounts'
import type { ServiceAccountMethod } from '@/lib/desktop/service-accounts-client'

type Draft = { methodId: string | null; values: Record<string, string> }

export function DesktopServiceAccountForm({
    identity,
    methods,
    saved,
    submitLabel,
    onSubmit,
    onCancel,
}: {
    identity: string
    methods: ServiceAccountMethod[]
    saved: DesktopServiceAccountView | null
    submitLabel: string
    onSubmit: (methodId: string, values: Record<string, string>) => Promise<void>
    onCancel: () => void
}) {
    const initialMethod = saved?.authMethodId ?? (methods.length === 1 ? methods[0].id : null)
    const [drafts, setDrafts] = useState<Record<string, Draft>>(() => ({ [identity]: { methodId: initialMethod, values: saved ? { ...saved.publicInputs } : {} } }))
    const draft = drafts[identity] ?? { methodId: initialMethod, values: saved ? { ...saved.publicInputs } : {} }
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [reconcile, setReconcile] = useState(false)
    const alive = useRef(true)
    const epoch = useRef(0)
    const pending = useRef(false)
    const identityRef = useRef(identity)
    identityRef.current = identity
    useEffect(() => {
        epoch.current += 1
    }, [identity])
    useEffect(() => {
        alive.current = true
        return () => {
            alive.current = false
            epoch.current += 1
        }
    }, [])
    const method = methods.find(item => item.id === draft.methodId)
    const supported = !!method && method.availability.supported && (method.kind === 'none' || method.kind === 'key')
    const inputs = (method?.inputs ?? []) as InputDef[]
    function update(next: Partial<Draft>) {
        setDrafts(current => ({ ...current, [identity]: { ...(current[identity] ?? draft), ...next } }))
    }
    function cancel() {
        if (!pending.current) {
            epoch.current += 1
            update({ values: saved ? { ...saved.publicInputs } : {} })
            setError('')
            setReconcile(false)
            onCancel()
            return
        }
        setReconcile(true)
        setError('Setup acknowledgement unavailable. Retry uses the same account.')
    }
    async function submit() {
        if (pending.current || !supported || !method) return
        pending.current = true
        setBusy(true)
        setError('')
        const current = epoch.current
        const submittedIdentity = identity
        try {
            await onSubmit(method.id, draft.values)
            if (!alive.current || current !== epoch.current || submittedIdentity !== identityRef.current) return
            setReconcile(false)
            update({ values: saved ? { ...saved.publicInputs } : {} })
        } catch (caught) {
            if (alive.current && current === epoch.current && submittedIdentity === identityRef.current) {
                setReconcile(true)
                setError(caught instanceof Error ? caught.message : 'Setup acknowledgement unavailable. Retry uses the same account.')
            }
        } finally {
            pending.current = false
            if (alive.current && current === epoch.current) setBusy(false)
        }
    }
    const missing = inputs.some(input => input.required && !(input.secret && saved?.configuredInputs[input.key]) && !(draft.values[input.key] ?? '').trim())
    if (!methods.length) return <p className="text-sm text-muted-foreground">No setup method is available for this app.</p>
    return (
        <div className="space-y-3" data-account-key={identity}>
            {!busy && methods.length > 1 && <AuthMethodPicker methods={methods.map(({ availability: _availability, ...method }) => method)} onSelect={id => { if (pending.current) return; epoch.current += 1; update({ methodId: id, values: {} }); setError('') }} />}
            <div className="space-y-1">
                {methods.map(item => (
                    <p key={item.id} className="text-xs text-muted-foreground">
                        {item.label || methodKindLabel(item.kind)}: {item.availability.supported ? 'Available locally' : `Unavailable — ${item.availability.reason ?? 'This method is not supported on this Mac.'}`}
                    </p>
                ))}
            </div>
            {method && <p className="text-sm font-medium">{method.label || methodKindLabel(method.kind)}</p>}
            {method && !supported && <p role="status" className="text-xs text-muted-foreground">{method.availability.reason ?? 'This method is unavailable on this Mac. No hosted sign-in will be started.'}</p>}
            {supported && method && (
                <>
                    <ServiceFields inputs={inputs} values={draft.values} onChange={(key, value) => { if (!pending.current) { epoch.current += 1; update({ values: { ...draft.values, [key]: value } }); setError('') } }} />
                    <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={busy || missing} onClick={() => void submit()}>{busy ? 'Saving…' : submitLabel}</Button>
                        <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
                    </div>
                </>
            )}
            {saved && Object.keys(saved.configuredInputs).length > 0 && <p className="text-xs text-muted-foreground">Credential configured. Saved credentials are never returned to this form.</p>}
            {reconcile && <p role="status" className="text-xs text-muted-foreground">This attempt is kept for reconciliation. It will not be copied onto another account.</p>}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">Saving does not enable tool permissions. Readiness comes from the saved connection, not from this draft.</p>
        </div>
    )
}
