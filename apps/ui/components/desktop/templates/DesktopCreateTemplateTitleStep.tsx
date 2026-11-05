'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TITLE_LIMIT } from '@/lib/templates/limits'

export function DesktopCreateTemplateTitleStep({ onCreate, onCancel }: {
    onCreate: (title: string) => Promise<void>
    onCancel: () => void
}) {
    const [title, setTitle] = useState('')
    const [busy, setBusy] = useState(false)
    return <form className="flex min-h-0 flex-1 flex-col" onSubmit={async event => {
        event.preventDefault()
        if (!title.trim() || busy) return
        setBusy(true)
        try { await onCreate(title.trim()) } finally { setBusy(false) }
    }}>
        <div className="min-h-0 flex-1 overflow-y-auto">
            <Input
                label="Title"
                autoFocus
                maxLength={TITLE_LIMIT}
                placeholder="e.g. Research team"
                helperText={`${title.length}/${TITLE_LIMIT} · Private to this workspace.`}
                value={title}
                onChange={event => setTitle(event.target.value)}
            />
        </div>
        <DialogFooter className="mt-auto -mx-6 -mb-6 border-t bg-muted/50 px-6 py-4">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={!title.trim() || busy} loading={busy}>Continue</Button>
        </DialogFooter>
    </form>
}
