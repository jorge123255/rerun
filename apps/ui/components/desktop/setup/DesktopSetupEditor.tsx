'use client'

import { isSetupAnswered } from '@rerun/contracts'
import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { CheckIcon, Loader2Icon } from '@/lib/icons'
import { DesktopSetupFields, type DesktopSetupDraft } from './DesktopSetupFields'

export function DesktopSetupEditor({ value, defaultPrompt, dirty, saving, saved, error, onChange, onSave, onCancel }: {
    value: DesktopSetupDraft
    defaultPrompt: string
    dirty: boolean
    saving: boolean
    saved: boolean
    error: string
    onChange: (next: DesktopSetupDraft) => void
    onSave: () => void
    onCancel: () => void
}) {
    const cancel = (
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={dirty ? undefined : onCancel} className="flex-1">
            Cancel
        </Button>
    )

    return (
        <>
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
            <DesktopSetupFields value={value} defaultPrompt={defaultPrompt} onChange={onChange} disabled={saving} />
            <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" onClick={onSave} disabled={saving || !dirty || !isSetupAnswered(value)} className="flex-1">
                    {saved ? (
                        <><CheckIcon className="mr-1.5 size-3.5 text-emerald-500" /> Saved</>
                    ) : saving ? (
                        <><Loader2Icon className="mr-1.5 size-3.5 animate-spin" /> Saving...</>
                    ) : 'Save'}
                </Button>
                {dirty ? (
                    <ConfirmDialog
                        title="Discard unsaved setup changes?"
                        description="Your changes to the required answer and install instructions will be lost."
                        confirmLabel="Discard changes"
                        onConfirm={onCancel}
                    >
                        {cancel}
                    </ConfirmDialog>
                ) : cancel}
            </div>
        </>
    )
}
