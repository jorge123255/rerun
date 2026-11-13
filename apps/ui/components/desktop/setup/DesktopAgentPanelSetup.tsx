'use client'

import type { DesktopSetupView } from '@rerun/contracts'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SkeletonForm } from '@/components/ui/skeleton'
import { useDesktopLocale } from '../DesktopLocale'
import { DesktopSetupEditor } from './DesktopSetupEditor'
import type { DesktopSetupDraft } from './DesktopSetupFields'
import { useDesktopSetup } from './useDesktopSetup'

export function DesktopAgentPanelSetup(props: { agentId: string; onDirtyChange?: (dirty: boolean) => void; onSavingChange?: (saving: boolean) => void; onCancel?: () => void; onSaved?: (view: DesktopSetupView) => void }) {
    return <AuthorSetup key={props.agentId} {...props} />
}

function AuthorSetup({ agentId, onDirtyChange, onSavingChange, onCancel, onSaved }: {
    agentId: string
    onDirtyChange?: (dirty: boolean) => void
    onSavingChange?: (saving: boolean) => void
    onCancel?: () => void
    onSaved?: (view: DesktopSetupView) => void
}) {
    const { t } = useDesktopLocale()
    const setup = useDesktopSetup(agentId)
    const [draft, setDraft] = useState<DesktopSetupDraft | null>(null)
    const [acknowledged, setAcknowledged] = useState<DesktopSetupDraft | null>(null)
    const [saved, setSaved] = useState(false)
    const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const loadedRevision = useRef('')
    const dirty = !!draft && !!acknowledged && (draft.required !== acknowledged.required || draft.prompt !== acknowledged.prompt)

    useEffect(() => {
        if (!setup.view || dirty || loadedRevision.current === setup.view.revision) return
        const next = { required: setup.view.required, prompt: setup.view.prompt }
        loadedRevision.current = setup.view.revision
        setDraft(next)
        setAcknowledged(next)
    }, [setup.view, dirty])

    useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])
    useEffect(() => {
        onSavingChange?.(setup.mutating === 'save')
        return () => onSavingChange?.(false)
    }, [setup.mutating, onSavingChange])
    useEffect(() => {
        if (!dirty) return
        const guard = (event: BeforeUnloadEvent) => { event.preventDefault() }
        window.addEventListener('beforeunload', guard)
        return () => window.removeEventListener('beforeunload', guard)
    }, [dirty])
    useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current) }, [])

    const save = async () => {
        if (!draft || !dirty) return
        const result = await setup.save(draft)
        if (!result) return
        const next = { required: result.view.required, prompt: result.view.prompt }
        loadedRevision.current = result.view.revision
        setDraft(next)
        setAcknowledged(next)
        setSaved(true)
        onSaved?.(result.view)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 2000)
    }

    const cancel = () => {
        if (acknowledged) setDraft(acknowledged)
        setSaved(false)
        setup.clearError()
        onCancel?.()
    }

    if (setup.loading && !setup.view) {
        return <div className="flex flex-col gap-4 p-4"><SkeletonForm /></div>
    }

    if (!setup.view || !draft || !acknowledged) {
        return (
            <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
                <p role="alert" className="text-xs text-destructive">{setup.error || t('coworkerSetup.author.unreachable')}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void setup.refresh()}>{t('coworkerSetup.retry')}</Button>
            </div>
        )
    }

    return (
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
            <p className="text-xs text-muted-foreground">
                {t('coworkerSetup.author.intro')}
            </p>
            <DesktopSetupEditor
                value={draft}
                defaultPrompt={setup.view.defaultPrompt}
                dirty={dirty}
                saving={setup.mutating === 'save'}
                saved={saved}
                error={setup.error}
                onChange={next => { setDraft(next); setSaved(false) }}
                onSave={() => void save()}
                onCancel={cancel}
            />
        </div>
    )
}
