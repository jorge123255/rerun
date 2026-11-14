'use client'

import { useRef, useState, useSyncExternalStore } from 'react'
import { ProfilePanel } from '@/components/account/ProfilePanel'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DialogHeaderBar } from '@/components/dialogs/DialogHeaderBar'
import { CircleUserIcon } from '@/lib/icons'
import { holdDraftAdmission, isDesktopQuitting, subscribeDraftShutdown } from '@/lib/desktop/draft-writes'
import { desktopProfilePhotoUrl, desktopProfileSchema, type DesktopProfile } from '@/lib/desktop/local-profile'
import { useDesktopLocale } from './DesktopLocale'

type Props = {
    open: boolean
    profile: { displayName: string; photoId?: string | null }
    onOpenChange: (open: boolean) => void
    onSaved: (profile: DesktopProfile) => void
}

export function DesktopLocalProfileDialog({ open, profile, onOpenChange, onSaved }: Props) {
    const { language } = useDesktopLocale()
    const copy = language.messages.localProfile
    const [saving, setSaving] = useState(false)
    const active = useRef(false)
    const quitting = useSyncExternalStore(subscribeDraftShutdown, isDesktopQuitting, () => false)
    const change = async (path: string, request: RequestInit) => {
        if (active.current || isDesktopQuitting()) throw new Error(copy.fields.failed)
        active.current = true
        setSaving(true)
        const release = holdDraftAdmission()
        try {
            const response = await fetch('/api/desktop/profile' + path, { ...request, signal: AbortSignal.timeout(20_000) })
            const body: unknown = await response.json().catch(() => null)
            if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : copy.fields.failed)
            onSaved(desktopProfileSchema.parse(body))
        } finally {
            active.current = false
            setSaving(false)
            release()
        }
    }
    const photo = desktopProfilePhotoUrl(profile.photoId)
    const blocked = saving || quitting
    return <Dialog open={open} onOpenChange={next => { if (!active.current && !isDesktopQuitting()) onOpenChange(next) }} asSheet={false} dismissible={!blocked}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md" showCloseButton={!blocked}
            onEscapeKeyDown={event => { if (active.current || isDesktopQuitting()) event.preventDefault() }}
            onInteractOutside={event => { if (active.current || isDesktopQuitting()) event.preventDefault() }}
            onCloseAutoFocus={event => {
                if (isDesktopQuitting()) return
                event.preventDefault()
                document.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')?.focus({ preventScroll: true })
            }}>
            <DialogHeaderBar icon={CircleUserIcon} title={copy.title} description={copy.description} />
            {open && <ProfilePanel name={profile.displayName} avatarUrl={photo} fallbackLabel={null}
                photoFileUrl={value => value === photo ? value : null}
                copy={{ ...copy.fields, photoHelp: copy.photoHelp }}
                photoAccept="image/png,image/jpeg,image/webp"
                disabled={blocked}
                saveName={name => change('', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })}
                uploadAvatar={file => change('/photo', { method: 'PUT', headers: { 'content-type': file.type }, body: file })}
                removeAvatar={() => change('/photo', { method: 'DELETE' })} />}
        </DialogContent>
    </Dialog>
}
