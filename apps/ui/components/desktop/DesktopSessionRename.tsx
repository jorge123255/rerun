'use client'

import { CONVERSATION_TITLE_MAX } from '@rerun/contracts'
import { useRenameField } from '@rerun/ui/forms'
import { useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { isDesktopQuitting } from '@/lib/desktop/draft-writes'
import { useDesktopLocale } from './DesktopLocale'

type Target = { id: string; surface: 'tab' | 'history' }

export function useDesktopSessionRename(renameTitle: (id: string, title: string) => Promise<boolean>) {
    const [target, setTarget] = useState<Target | null>(null)
    const [status, setStatus] = useState<'editing' | 'saving' | 'error'>('editing')
    const pending = useRef(false)
    return {
        target, status,
        start(next: Target) {
            if (pending.current || isDesktopQuitting()) return
            setTarget(next)
            setStatus('editing')
        },
        cancel() {
            if (!pending.current) setTarget(null)
        },
        async submit(title: string) {
            if (!target || pending.current || isDesktopQuitting()) return
            pending.current = true
            setStatus('saving')
            try {
                if (await renameTitle(target.id, title)) setTarget(null)
                else setStatus('error')
            } catch {
                setStatus('error')
            } finally {
                pending.current = false
            }
        },
    }
}

export type DesktopSessionRename = ReturnType<typeof useDesktopSessionRename>

export function DesktopSessionRenameField({ title, rename, compact }: { title: string; rename: DesktopSessionRename; compact?: boolean }) {
    const { t } = useDesktopLocale()
    const busy = rename.status === 'saving'
    const error = rename.status === 'error'
    const { inputProps } = useRenameField({ name: title, busy, onSubmit: rename.submit, onCancel: rename.cancel })
    const props = {
        ...inputProps,
        maxLength: CONVERSATION_TITLE_MAX,
        readOnly: busy,
        'aria-label': t('sessionRename.label'),
        'aria-invalid': error || undefined,
        title: error ? t('sessionRename.failed') : undefined,
    }
    if (compact) return <div className={cn('flex h-7 shrink-0 items-center gap-1 rounded-md bg-background px-2 text-xs ring-1 ring-inset', error ? 'ring-destructive' : 'ring-primary')}>
        <input {...props} className="field-sizing-content min-w-16 max-w-[220px] bg-transparent outline-none read-only:opacity-60" />
        {busy && <Spinner className="size-3 text-muted-foreground" />}
        {error && <span role="alert" className="sr-only">{t('sessionRename.failed')}</span>}
    </div>
    return <div className="flex flex-col gap-1 px-1 py-1">
        <div className="relative">
            <Input {...props} className="h-9 pr-8 read-only:opacity-50" />
            {busy && <Spinner className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />}
        </div>
        {error && <p role="alert" className="px-1 text-[11px] text-destructive">{t('sessionRename.failed')}</p>}
    </div>
}
