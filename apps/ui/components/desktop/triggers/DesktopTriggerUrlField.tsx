'use client'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { CheckIcon, CopyIcon, Loader2Icon, RotateCwIcon } from '@/lib/icons'
import { useEffect, useState } from 'react'

/** Original TriggerUrlField — origin after mount; Copy is the only clipboard write of the secret URL. */
function useTriggerUrl(agentId: string, slug: string, token: string, originOverride: string | null): string {
    const path = `/api/desktop/trigger-ingress/${encodeURIComponent(agentId)}/${encodeURIComponent(slug)}/${encodeURIComponent(token)}`
    const [origin, setOrigin] = useState(originOverride ?? '')
    useEffect(() => {
        if (originOverride) {
            setOrigin(originOverride)
            return
        }
        setOrigin(typeof window !== 'undefined' ? window.location.origin : '')
    }, [originOverride])
    return origin ? `${origin}${path}` : path
}

type Props = {
    agentId: string
    slug: string
    token: string
    rotating: boolean
    onRotate: () => void
    /** When ingress is disabled, show an honest unavailable state instead of a fake public host. */
    ingressAvailable?: boolean
    originOverride?: string | null
}

export function DesktopTriggerUrlField({ agentId, slug, token, rotating, onRotate, ingressAvailable = true, originOverride = null }: Props) {
    const [copied, setCopied] = useState(false)
    const url = useTriggerUrl(agentId, slug, token, originOverride)

    function copy() {
        if (!ingressAvailable || !token) return
        navigator.clipboard
            .writeText(url)
            .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
            })
            .catch(() => {})
    }

    if (!token) {
        return (
            <Field label="Webhook URL" helperText="Rotating issues a new secret and the URL that goes with it.">
                <div className="flex items-center gap-1.5">
                    <p className="flex min-h-8 min-w-0 flex-1 items-center rounded-md border border-dashed border-input px-3 py-1.5 text-xs text-muted-foreground">This trigger has no secret yet, so it has no URL.</p>
                    <Button size="sm" variant="outline" onClick={onRotate} disabled={rotating}>
                        {rotating ? <Loader2Icon className="size-3.5 animate-spin" /> : 'Get URL'}
                    </Button>
                </div>
            </Field>
        )
    }

    if (!ingressAvailable) {
        return (
            <Field label="Webhook URL" helperText="Local webhook delivery is not available.">
                <p className="flex min-h-8 items-center rounded-md border border-dashed border-input px-3 py-1.5 text-xs text-muted-foreground">Local webhook URL unavailable.</p>
            </Field>
        )
    }

    return (
        <Field label="Webhook URL" helperText="This URL works only on this Mac. A local program holding it can start a run. Treat it as a secret. Copying it or opening it in a browser starts nothing.">
            <div className="flex flex-wrap items-center gap-1.5">
                <code className="flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-input bg-muted/40 px-3 font-mono text-xs">{url}</code>
                <Button size="icon-sm" variant="outline" aria-label="Copy the webhook URL" onClick={copy}>
                    {copied ? <CheckIcon className="size-3.5 text-emerald-500" /> : <CopyIcon className="size-3.5" />}
                </Button>
                <ConfirmDialog
                    title="Rotate the webhook secret?"
                    description="The current URL stops working right away. You have to paste the new one wherever this trigger is called from."
                    confirmVariant="default"
                    confirmLabel="Rotate"
                    onConfirm={onRotate}
                >
                    <Button size="icon-sm" variant="outline" aria-label="Rotate the secret" title="Rotate the secret" disabled={rotating}>
                        {rotating ? <Loader2Icon className="size-3.5 animate-spin" /> : <RotateCwIcon className="size-3.5" />}
                    </Button>
                </ConfirmDialog>
            </div>
        </Field>
    )
}
