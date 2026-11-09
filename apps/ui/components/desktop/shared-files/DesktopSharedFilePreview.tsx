'use client'

import { BrainTopBar, type BrainCrumb } from '@/components/brain/BrainTopBar'
import { FilePreview } from '@/components/files/FilePreview'
import { filePreviewKind } from '@/lib/files/preview'
import { useSiblingFiles } from '@/components/files/useSiblingFiles'
import { Button } from '@/components/ui/button'
import { readDesktopSharedPreview, type DesktopSharedEntry } from '@/lib/desktop/shared-workspace-files'
import { saveDesktopSharedFile, sharedMediaUrl } from '@/lib/desktop/shared-file-previews'
import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileIcon, FolderIcon } from '@/lib/icons'
import { Badge } from '@rerun/ui/primitives'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DesktopFileImagePreview } from '../DesktopFileImagePreview'
import { DesktopFileAudioPreview } from '../DesktopFileAudioPreview'
import { DesktopFileVideoPreview } from '../DesktopFileVideoPreview'
import { DesktopFilePdfPreview } from '../DesktopFilePdfPreview'

const TEXT = /\.(txt|md)$/i
const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
const parentPath = (path: string) => path.split('/').filter(Boolean).slice(0, -1).join('/')

function folderCrumbs(path: string, onSelect: (path: string) => void): BrainCrumb[] {
    const parts = path.split('/').filter(Boolean)
    return [
        { label: 'Files', icon: FolderIcon, onClick: () => onSelect('') },
        ...parts.map((part, index) => ({ label: part, onClick: () => onSelect(parts.slice(0, index + 1).join('/')) })),
    ]
}

function messageOf(error: unknown, fallback: string): string {
    return error instanceof Error && error.message ? error.message : fallback
}

export function DesktopSharedFilePreview({ path, entries, onOpen }: { path: string; entries: DesktopSharedEntry[] | undefined; onOpen: (path: string, directory: boolean) => void }) {
    const dir = parentPath(path)
    const name = path.split('/').pop() ?? path
    const text = TEXT.test(name)
    const kind = filePreviewKind(name)
    const [preview, setPreview] = useState<{ path: string; content: string | null; truncated: boolean; error: string | null } | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [previewHash, setPreviewHash] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const saveController = useRef<AbortController | null>(null)

    useEffect(() => {
        if (!text) return
        const controller = new AbortController()
        setPreview(null)
        void readDesktopSharedPreview(path, controller.signal)
            .then(page => { if (!controller.signal.aborted) {
                setPreviewHash(page.editIdentity?.expectedSha256 ?? null)
                setPreview({ path, content: page.content, truncated: page.truncated, error: null })
            } })
            .catch(error => { if (!controller.signal.aborted) setPreview({ path, content: null, truncated: false, error: messageOf(error, 'This file could not be read') }) })
        return () => controller.abort()
    }, [path, text, attempt])

    useEffect(() => {
        setSaved(false)
        setSaving(false)
        saveController.current?.abort()
        return () => { saveController.current?.abort() }
    }, [path])

    const siblings = useSiblingFiles({
        entries: (entries ?? []).filter(entry => entry.type !== 'dir'),
        openName: name,
        onOpen: next => onOpen(joinPath(dir, next), false),
    })
    const ready = preview?.path === path ? preview : null
    const canSave = kind ? !!previewHash : !text || ready?.content != null
    const back = () => onOpen(dir, true)

    async function save() {
        if (saving || !canSave) return
        const controller = new AbortController()
        saveController.current = controller
        setSaving(true)
        setSaved(false)
        try {
            const wrote = await saveDesktopSharedFile(path, name, previewHash ?? undefined, controller.signal)
            if (controller.signal.aborted) return
            if (wrote) setSaved(true)
            else toast.error('The shared file was not saved.')
        } catch (error) {
            if (!controller.signal.aborted) toast.error(messageOf(error, 'The shared file could not be saved.'))
        } finally {
            if (saveController.current === controller) saveController.current = null
            setSaving(false)
        }
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <BrainTopBar crumbs={[...folderCrumbs(dir, next => onOpen(next, true)), { label: name, icon: FileIcon }]}>
                {siblings && <>
                    <Button size="icon-sm" variant="ghost" onClick={siblings.previous} title="Previous file" aria-label="Previous file"><ChevronLeftIcon className="size-4" /></Button>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{siblings.index + 1} / {siblings.total}</span>
                    <Button size="icon-sm" variant="ghost" onClick={siblings.next} title="Next file" aria-label="Next file"><ChevronRightIcon className="size-4" /></Button>
                </>}
                <Button type="button" size="xs" variant="outline" disabled={saving || !canSave} onClick={() => void save()}><DownloadIcon className="size-3.5" />{saving ? 'Saving…' : 'Save As'}</Button>
                {saved && <Badge size="xs" tone="green" glow={false}>Saved {name}</Badge>}
                {ready?.truncated && <Badge size="xs" tone="orange" glow={false}>Truncated</Badge>}
            </BrainTopBar>
            <div className="flex min-h-0 flex-1 flex-col border-t border-border">
                {text ? (
                    ready?.error ? <div className="space-y-2 p-3"><p role="alert" className="text-xs text-destructive">{ready.error}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Retry</Button></div> : <FilePreview fileName={name} content={ready?.content ?? null} rawUrl="" loading={!ready} />
                ) : kind === 'image' ? <DesktopFileImagePreview name={name} path={path} srcUrl={sharedMediaUrl(path, 'image')} onBack={back} siblings={siblings} onPreviewIdentity={setPreviewHash} />
                    : kind === 'audio' ? <DesktopFileAudioPreview name={name} path={path} srcUrl={sharedMediaUrl(path, 'audio')} onBack={back} siblings={siblings} onPreviewIdentity={setPreviewHash} />
                    : kind === 'video' ? <DesktopFileVideoPreview name={name} path={path} srcUrl={sharedMediaUrl(path, 'video')} onBack={back} siblings={siblings} onPreviewIdentity={setPreviewHash} />
                    : kind === 'pdf' ? <DesktopFilePdfPreview name={name} path={path} srcUrl={sharedMediaUrl(path, 'pdf')} onBack={back} siblings={siblings} onPreviewIdentity={setPreviewHash} />
                    : <FilePreview fileName={name} content={null} rawUrl={sharedMediaUrl(path, 'download')} loading={false} />}
            </div>
        </div>
    )
}
