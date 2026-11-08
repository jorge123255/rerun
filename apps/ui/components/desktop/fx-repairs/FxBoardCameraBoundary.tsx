'use client'
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { IsoCamera } from '@rerun/ui/iso-grid'
import { Button } from '@/components/ui/button'
import { FxBoardCameraController, type FxCameraPersistence } from '@/lib/desktop/fx-repairs/board-camera'

export type FxBoardCameraBinding = { mountKey: string; initialCamera: IsoCamera | null; onCameraChange(camera: IsoCamera): void }
export function FxBoardCameraBoundary(props: {
    workspaceId: number; currentWorkspace(): number | null; persistence: FxCameraPersistence
    bindFlush?(flush: (() => Promise<boolean>) | null): void
    children(binding: FxBoardCameraBinding): ReactNode
}) {
    return <WorkspaceCamera key={props.workspaceId} {...props} />
}
function WorkspaceCamera(props: Parameters<typeof FxBoardCameraBoundary>[0]) {
    const latest = useRef(props); latest.current = props
    const [controller, setController] = useState<FxBoardCameraController | null>(null)
    useEffect(() => {
        const owned = new FxBoardCameraController(props.workspaceId, props.persistence, () => latest.current.currentWorkspace())
        setController(owned); latest.current.bindFlush?.(() => owned.flush()); void owned.load()
        return () => { latest.current.bindFlush?.(null); owned.close() }
    }, [props.workspaceId, props.persistence])
    return controller ? <CameraView controller={controller}>{props.children}</CameraView> : <p role="status" className="p-3 text-xs text-muted-foreground">Restoring board view…</p>
}
function CameraView({ controller, children }: { controller: FxBoardCameraController; children(binding: FxBoardCameraBinding): ReactNode }) {
    const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot)
    return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {state.error && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 p-2 text-xs text-muted-foreground">
            <span>{state.error}</span>
            {state.phase === 'uncertain' && <Button type="button" size="xs" variant="outline" onClick={() => void controller.retry()}>Retry same save</Button>}
            <Button type="button" size="xs" variant="outline" onClick={() => void controller.load()}>Load saved view</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => controller.useDefaultView()}>Use default view</Button>
        </div>}
        {state.ready ? children({ mountKey: `board:${controller.workspaceId}:${state.mountGeneration}`, initialCamera: state.initialCamera, onCameraChange: camera => controller.change(camera) })
            : <p role="status" className="p-3 text-xs text-muted-foreground">Restoring board view…</p>}
    </div>
}
