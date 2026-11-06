'use client'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import type { FileCardEntry } from '@rerun/contracts'
import { desktopResultFileName, desktopResultFilePreviewKind, desktopResultFileRoute } from '@/lib/desktop/server/result-files/contract'
import { DownloadIcon, FileIcon } from '@/lib/icons'
import { useEffect, useRef, useState } from 'react'
import { resultFileAnnouncement, resultFileBytesAccepted, resultFileMayWrite, resultFileTicketKey } from './state'

type SaveResultFile = (name: string, bytes: Uint8Array) => Promise<boolean>
type Preview = { kind: 'none' } | { kind: 'text'; content: string } | { kind: 'image' | 'audio' | 'video'; src: string }
type Phase =
    | { status: 'loading' }
    | { status: 'ready'; preview: Preview }
    | { status: 'downloading'; preview: Preview }
    | { status: 'unavailable'; message: string }
    | { status: 'failed'; message: string; preview: Preview }
    | { status: 'cancelled'; preview: Preview }
    | { status: 'saved'; preview: Preview }

const none: Preview = { kind: 'none' }
const changed = 'This file changed and was not downloaded.'
const missed = 'This file was not downloaded.'

function mediaType(path: string, kind: 'image' | 'audio' | 'video'): string {
    const ext = path.split('.').pop()?.toLowerCase()
    if (kind === 'image') return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png'
    if (kind === 'audio') return ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : ext === 'ogg' ? 'audio/ogg' : ext === 'flac' ? 'audio/flac' : 'audio/wav'
    return ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4'
}

async function readExact(response: Response, expected: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get('content-length')
    if (declared === null || Number(declared) !== expected || !response.body) throw new Error('length')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
        while (true) {
            signal.throwIfAborted()
            const step = await reader.read()
            if (step.done) break
            size += step.value.byteLength
            if (size > expected) throw new Error('length')
            chunks.push(step.value)
        }
    } finally {
        await reader.cancel().catch(() => {})
    }
    if (size !== expected) throw new Error('length')
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
}

async function fetchResultFile(agentId: string, file: FileCardEntry, signal: AbortSignal): Promise<{ response: Response; bytes: Uint8Array }> {
    const response = await fetch(desktopResultFileRoute(agentId), {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: file.path, scope: file.scope === 'shared' ? 'shared' : 'agent', identity: file.identity, size: file.size }),
        signal,
    })
    if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return { response, bytes: new Uint8Array() }
    }
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (type !== 'application/octet-stream') {
        await response.body?.cancel().catch(() => {})
        throw new Error('type')
    }
    return { response, bytes: await readExact(response, file.size, signal) }
}

function failureMessage(response: Response): string {
    if (response.status === 409) return changed
    if (response.status === 404) return 'This file is no longer available.'
    if (response.status === 503) return 'Result file downloads are not available.'
    return missed
}

function browserDownload(name: string, bytes: Uint8Array) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url
    link.download = name
    link.rel = 'noopener'
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
}

function textOf(bytes: Uint8Array): string | undefined {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { return undefined }
}

export function DesktopResultFilePreview(props: { agentId: string; file: FileCardEntry; saveResultFile?: SaveResultFile; onClose: () => void }) {
    const ticket = resultFileTicketKey(props.agentId, props.file)
    return <OwnedResultFilePreview key={ticket} {...props} />
}

function OwnedResultFilePreview({ agentId, file, saveResultFile, onClose }: { agentId: string; file: FileCardEntry; saveResultFile?: SaveResultFile; onClose: () => void }) {
    const previewKind = desktopResultFilePreviewKind(file)
    const safeName = desktopResultFileName(file.name)
    const ticket = resultFileTicketKey(agentId, file)
    const [attempt, setAttempt] = useState(0)
    const [phase, setPhase] = useState<Phase>(() => previewKind === 'none' ? { status: 'ready', preview: none } : { status: 'loading' })
    const saveRef = useRef(saveResultFile)
    const generation = useRef(0)
    const alive = useRef(true)
    const abortRef = useRef<AbortController | null>(null)
    const urlRef = useRef<string | null>(null)
    saveRef.current = saveResultFile

    useEffect(() => () => {
        alive.current = false
        generation.current += 1
        abortRef.current?.abort()
    }, [])

    useEffect(() => {
        if (previewKind === 'none' || !file.identity) {
            if (previewKind !== 'none' && !file.identity) setPhase({ status: 'unavailable', message: 'This file is no longer available.' })
            return
        }
        const controller = new AbortController()
        abortRef.current = controller
        let active = true
        const release = (src: string | null) => { if (src) URL.revokeObjectURL(src) }
        void (async () => {
            try {
                const loaded = await fetchResultFile(agentId, file, controller.signal)
                if (!active) return
                const declared = loaded.response.headers.get('content-length')
                const accepted = resultFileBytesAccepted({
                    aborted: controller.signal.aborted, startedTicket: ticket, currentTicket: ticket,
                    byteLength: loaded.bytes.byteLength, expectedSize: file.size,
                    declaredLength: declared === null ? null : Number(declared),
                    identity: loaded.response.headers.get('x-rerun-result-identity'), expectedIdentity: file.identity ?? '',
                })
                if (!loaded.response.ok || !accepted) {
                    setPhase({ status: 'unavailable', message: loaded.response.ok ? changed : failureMessage(loaded.response) })
                    return
                }
                if (previewKind === 'text') {
                    const content = textOf(loaded.bytes)
                    setPhase({ status: 'ready', preview: content === undefined ? none : { kind: 'text', content } })
                    return
                }
                const src = URL.createObjectURL(new Blob([loaded.bytes], { type: mediaType(file.path, previewKind) }))
                urlRef.current = src
                setPhase({ status: 'ready', preview: { kind: previewKind, src } })
            } catch {
                if (!active || controller.signal.aborted) return
                setPhase({ status: 'unavailable', message: missed })
            }
        })()
        return () => {
            active = false
            controller.abort()
            release(urlRef.current)
            urlRef.current = null
        }
    }, [agentId, attempt, file, previewKind, ticket])

    function currentPreview(): Preview {
        if (phase.status === 'loading' || phase.status === 'unavailable') return none
        return phase.preview
    }

    async function download() {
        if (!safeName || !file.identity) return
        const mine = ++generation.current
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller
        const preview = currentPreview()
        const started = ticket
        setPhase({ status: 'downloading', preview })
        try {
            const loaded = await fetchResultFile(agentId, file, controller.signal)
            if (mine !== generation.current) return
            const declared = loaded.response.headers.get('content-length')
            const accepted = loaded.response.ok && resultFileBytesAccepted({
                aborted: false, startedTicket: started, currentTicket: resultFileTicketKey(agentId, file),
                byteLength: loaded.bytes.byteLength, expectedSize: file.size,
                declaredLength: declared === null ? null : Number(declared),
                identity: loaded.response.headers.get('x-rerun-result-identity'), expectedIdentity: file.identity,
            })
            if (!accepted) {
                setPhase({ status: 'failed', message: loaded.response.ok ? missed : failureMessage(loaded.response), preview })
                return
            }
            const mayWrite = resultFileMayWrite({ accepted: true, aborted: controller.signal.aborted || !alive.current, stale: started !== resultFileTicketKey(agentId, file) })
            if (!mayWrite || mine !== generation.current) {
                if (alive.current && mine === generation.current && !controller.signal.aborted) setPhase({ status: 'failed', message: missed, preview })
                return
            }
            const save = saveRef.current
            if (!save) {
                browserDownload(safeName, loaded.bytes)
                if (mine === generation.current) setPhase({ status: 'ready', preview })
                return
            }
            const wrote = await save(safeName, loaded.bytes)
            if (mine !== generation.current || started !== resultFileTicketKey(agentId, file)) return
            const announced = resultFileAnnouncement({ accepted: true, aborted: false, stale: false, save: wrote === true })
            setPhase(announced.saved ? { status: 'saved', preview } : { status: 'failed', message: 'The file was not saved.', preview })
        } catch {
            if (mine !== generation.current) return
            setPhase(controller.signal.aborted ? { status: 'cancelled', preview } : { status: 'failed', message: missed, preview })
        }
    }

    function cancel() {
        generation.current += 1
        abortRef.current?.abort()
        const preview = currentPreview()
        setPhase({ status: 'cancelled', preview })
    }

    const preview = phase.status === 'loading' || phase.status === 'unavailable' ? none : phase.preview
    const showSaved = phase.status === 'saved'
    return (
        <Dialog open onOpenChange={open => !open && onClose()}>
            <DialogContent aria-describedby={undefined} className="flex h-[80vh] flex-col gap-0 p-0 sm:max-w-4xl">
                <div className="flex shrink-0 items-center gap-2 border-b border-border py-2 pl-4 pr-12">
                    <DialogTitle className="min-w-0 flex-1 truncate text-left font-mono text-xs font-normal text-muted-foreground">{file.name}</DialogTitle>
                </div>
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    {phase.status === 'loading' ? (
                        <p className="p-6 text-xs text-muted-foreground">Loading…</p>
                    ) : phase.status === 'unavailable' ? (
                        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                            <p className="text-xs text-destructive">{phase.message}</p>
                            <Button type="button" variant="outline" size="sm" onClick={() => { setPhase({ status: 'loading' }); setAttempt(value => value + 1) }}>Try again</Button>
                        </div>
                    ) : preview.kind === 'text' ? (
                        <pre className="h-full overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-all">{preview.content}</pre>
                    ) : preview.kind === 'image' ? (
                        <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                            {/* eslint-disable-next-line @next/next/no-img-element -- verified result-file bytes as a released object URL */}
                            <img src={preview.src} alt={file.name} className="max-h-full max-w-full object-contain" />
                        </div>
                    ) : preview.kind === 'audio' ? (
                        <div className="flex h-full items-center justify-center p-4">
                            <audio controls src={preview.src} className="w-full max-w-md" />
                        </div>
                    ) : preview.kind === 'video' ? (
                        <div className="flex h-full items-center justify-center overflow-auto bg-muted p-3">
                            <video controls src={preview.src} className="max-h-full max-w-full" />
                        </div>
                    ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
                            <FileIcon className="size-8" />
                            <p className="text-xs">No preview available for this file type</p>
                        </div>
                    )}
                </div>
                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
                    {showSaved && <p role="status" className="mr-auto text-xs text-muted-foreground">Saved</p>}
                    {phase.status === 'failed' && <p role="status" className="mr-auto text-xs text-destructive">{phase.message}</p>}
                    {phase.status === 'cancelled' && <p role="status" className="mr-auto text-xs text-muted-foreground">Download cancelled.</p>}
                    {!safeName ? (
                        <p className="text-xs text-destructive">This file name cannot be downloaded.</p>
                    ) : phase.status === 'downloading' ? (
                        <Button type="button" variant="outline" size="sm" onClick={cancel}>Cancel</Button>
                    ) : phase.status !== 'loading' && phase.status !== 'unavailable' && (
                        <Button type="button" variant="outline" size="sm" onClick={() => void download()}>
                            <DownloadIcon className="size-3.5" />
                            Download
                        </Button>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    )
}
