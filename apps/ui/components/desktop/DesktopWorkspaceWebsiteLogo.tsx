'use client'

import { useEffect, useRef, useState } from 'react'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { GlobeIcon } from '@/lib/icons'
import { useDesktopLocale } from './DesktopLocale'
import { LOGO_MAX_BYTES, NO_LOGO_FOUND, readLogoLink, type LogoLink } from '@/lib/desktop/workspace-logo-link'

// The original "Logo from a website or link" field, desktop-side. Preview bytes come from the
// authenticated logo-preview route and are shown only as a local blob URL — no remote address is
// ever an <img>. A successful preview reports the exact reviewed raster as a File (named from its
// content type so the installed icon multipart endpoint accepts it on Save) plus the local preview
// URL; a failed or cleared link reports null.
export type DesktopWorkspaceLinkSelection = { file: File; previewUrl: string }

export function DesktopWorkspaceWebsiteLogo({ disabled, onSelection }: {
    disabled?: boolean
    // Pending is reported synchronously with clearing the obsolete selection, so the parent
    // cannot submit yesterday's reviewed bytes for the newly typed address.
    onSelection: (selection: DesktopWorkspaceLinkSelection | null, pending: boolean) => void
}) {
    const { t } = useDesktopLocale()
    const [linkInput, setLinkInput] = useState('')
    const [error, setError] = useState('')
    const [previewSrc, setPreviewSrc] = useState<string | null>(null)
    const generation = useRef(0)
    const controller = useRef<AbortController | null>(null)
    const previewUrl = useRef<string | null>(null)
    const latestSelection = useRef(onSelection)
    latestSelection.current = onSelection
    const releasePreview = () => {
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current)
        previewUrl.current = null
    }
    useEffect(() => () => { controller.current?.abort(); releasePreview() }, [])
    // Saving must not be raced by a late preview: stop the field the moment the form disables it.
    useEffect(() => {
        if (disabled && controller.current) {
            controller.current.abort(); controller.current = null; generation.current += 1
            setError('Preview cancelled. Enter the address again to try again.')
            latestSelection.current(null, false)
        }
    }, [disabled])

    const change = (value: string) => {
        if (disabled) return
        setLinkInput(value)
        controller.current?.abort()
        controller.current = null
        generation.current += 1
        releasePreview()
        setPreviewSrc(null)
        setError('')
        const link = readLogoLink(value)
        if (!link) {
            onSelection(null, false)
            return
        }
        const next = new AbortController()
        controller.current = next
        const run = generation.current
        onSelection(null, true)
        void previewLink(link, run, next.signal)
    }

    const previewLink = async (link: LogoLink, run: number, signal: AbortSignal) => {
        const latest = () => signal.aborted || run !== generation.current
        try {
            const response = await fetch('/api/desktop/workspace/logo-preview', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ link: link.kind === 'site' ? link.domain : link.url }),
                signal,
                cache: 'no-store',
            })
            if (latest()) return
            if (!response.ok) {
                releasePreview()
                setPreviewSrc(null)
                const body = await response.json().catch(() => null) as { error?: string } | null
                if (latest()) return
                setError(typeof body?.error === 'string' ? body.error : NO_LOGO_FOUND)
                onSelection(null, false)
                return
            }
            const blob = await response.blob()
            if (latest()) return
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) || !blob.size || blob.size > LOGO_MAX_BYTES) throw new Error('Invalid logo preview')
            const kind = blob.type === 'image/jpeg' ? 'jpeg' : blob.type === 'image/webp' ? 'webp' : 'png'
            const url = URL.createObjectURL(blob)
            releasePreview()
            previewUrl.current = url
            setPreviewSrc(url)
            setError('')
            onSelection({ file: new File([blob], `logo.${kind}`, { type: blob.type }), previewUrl: url }, false)
        } catch {
            if (latest()) return
            releasePreview()
            setPreviewSrc(null)
            setError(NO_LOGO_FOUND)
            onSelection(null, false)
        } finally {
            if (run === generation.current) controller.current = null
        }
    }

    return (
        <Field label={t('workspaceForm.logoLink')} error={error === NO_LOGO_FOUND ? t('workspaceForm.noLogoFound') : error || undefined}>
            <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-2.5 flex size-5 -translate-y-1/2 items-center justify-center overflow-hidden rounded">
                    {/* The validated local blob has no remote Next Image source. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {previewSrc ? <img src={previewSrc} alt="" className="size-full object-contain" /> : <GlobeIcon className="size-4 text-muted-foreground" />}
                </span>
                <Input className="pl-10" placeholder="acme.com" inputMode="url" autoComplete="url" value={linkInput}
                    disabled={disabled} onChange={event => change(event.target.value)} />
            </div>
        </Field>
    )
}
