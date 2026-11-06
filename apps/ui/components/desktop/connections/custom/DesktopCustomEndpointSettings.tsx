'use client'

import { DetailBlock } from '@/components/connections/DetailBlock'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { defaultContextPlaceholder, endpointReady } from '@/lib/desktop/custom-providers'
import { useEffect, useState } from 'react'

type Props = {
    id: string
    baseUrl: string
    contextText: string
    vision: boolean
    epoch: number
    onBaseUrl: (value: string) => void
    onContext: (value: string) => void
    onVision: (vision: boolean) => void
}

/** Blur keeps the edit local. Save is the only write. An unfinished value is not sent. */
export function DesktopCustomEndpointSettings({ id, baseUrl, contextText, vision, epoch, onBaseUrl, onContext, onVision }: Props) {
    const [url, setUrl] = useState(baseUrl)
    const [windowText, setWindowText] = useState(contextText)
    useEffect(() => {
        setUrl(baseUrl)
        setWindowText(contextText)
    }, [epoch, baseUrl, contextText])
    return (
        <DetailBlock title="Endpoint">
            <div className="space-y-3">
                <Input id={`${id}-base-url`} hideRequired label="Base URL" value={url} onChange={event => setUrl(event.target.value)} onBlur={() => { const next = url.trim(); if (endpointReady(next) && next.replace(/\/+$/, '') !== baseUrl.replace(/\/+$/, '')) onBaseUrl(next) }} inputMode="url" spellCheck={false} className="h-8 font-mono text-xs" />
                <Input id={`${id}-context`} optional label="Context window" value={windowText} onChange={event => setWindowText(event.target.value)} onBlur={() => onContext(windowText)} inputMode="numeric" placeholder={defaultContextPlaceholder()} helperText="In tokens, for models the server does not size itself" className="h-8 font-mono text-xs" />
                <Field orientation="row" label="Models see images" helperText="Screenshots and the computer need it" htmlFor={`${id}-vision`}>
                    <Switch id={`${id}-vision`} checked={vision} onCheckedChange={onVision} className="shrink-0" />
                </Field>
            </div>
        </DetailBlock>
    )
}
