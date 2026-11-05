import type { Duplex } from 'node:stream'
import type { BotWall } from '../../tools/bot-wall.js'

// Resolved by authenticated server code. Never a renderer or model Docker name.
export type ScreenOwner = { engineAgentId: string; launchNonce: string }

// Issued by ensure. A guest or app restart must not reuse it.
export type ScreenTarget = ScreenOwner & { sessionGeneration: string }

export type ScreenPrerequisite =
    | 'ready'
    | 'docker-missing'
    | 'daemon-unreachable'
    | 'docker-wrong-arch'
    | 'image-missing'
    | 'image-wrong-arch'
    | 'name-conflict'

export type ScreenRunState = 'absent' | 'stopped' | 'starting' | 'running' | 'human'

export type ScreenStatus = {
    available: boolean
    prerequisite: ScreenPrerequisite
    state: ScreenRunState
}

export type EnsuredScreen = {
    target: ScreenTarget
    width: number
    height: number
}

export type ScreenLink = { href: string; text: string }

// Raw HTML and image bytes never enter the model-facing page result.
export type ScreenPage = {
    status: number
    finalUrl: string
    text: string
    truncated: boolean
    links: ScreenLink[]
    wall: BotWall | null
    exports?: ScreenSavedExports
}

export type ScreenShot = {
    image: Buffer
    mediaType: 'image/jpeg'
    width: number
    height: number
}

export type ScreenAction =
    | 'screenshot'
    | 'left_click'
    | 'right_click'
    | 'double_click'
    | 'mouse_move'
    | 'left_click_drag'
    | 'scroll'
    | 'type'
    | 'key'
    | 'wait'

// Same fields as the original computer tool input. Coordinates are pixels of the latest JPEG.
export type ScreenComputerInput = {
    action: ScreenAction
    coordinate?: readonly [number, number]
    start_coordinate?: readonly [number, number]
    text?: string
    scroll_direction?: 'up' | 'down' | 'left' | 'right'
    scroll_amount?: number
    duration?: number
}

export type ScreenNavigate = { url: string; links?: boolean; timeoutMs?: number; screenshotPath?: string }

export type ScreenExportArtifact = {
    kind: 'rendered-html' | 'screenshot'
    path: string
    mediaType: 'text/plain' | 'image/png'
    bytes: Buffer
    sha256: string
    width?: number
    height?: number
}
export type ScreenSavedExports = {
    files: Array<{ kind: ScreenExportArtifact['kind']; path: string; sha256: string; byteLength: number }>
    status: 'saved' | 'unknown' | 'refused' | 'unavailable'
}
export type ScreenNavigationExport = {
    htmlPath: string
    publish(artifacts: ScreenExportArtifact[], signal: AbortSignal): Promise<ScreenSavedExports>
}

export type ScreenLease = { token: string }

export type ScreenTakeover = { url: string | null }

export type ViewerMode = 'watch' | 'drive'

export type ScreenReconcile = {
    stopped: number
    skipped: number
    prerequisite: ScreenPrerequisite
}

export type IsolatedScreenService = {
    status(owner: ScreenOwner, signal: AbortSignal): Promise<ScreenStatus>
    ensure(owner: ScreenOwner, signal: AbortSignal): Promise<EnsuredScreen>
    navigate(target: ScreenTarget, input: ScreenNavigate, signal: AbortSignal, exports?: ScreenNavigationExport): Promise<ScreenPage>
    act(target: ScreenTarget, input: ScreenComputerInput, signal: AbortSignal): Promise<ScreenShot>
    startTakeover(target: ScreenTarget, signal: AbortSignal): Promise<ScreenLease>
    finishTakeover(target: ScreenTarget, lease: ScreenLease, signal: AbortSignal): Promise<ScreenTakeover>
    stop(target: ScreenTarget, signal: AbortSignal): Promise<void>
    withViewer<T>(target: ScreenTarget, mode: ViewerMode, signal: AbortSignal, connect: (stream: Duplex) => Promise<T>): Promise<T>
    reconcile(launchNonce: string, signal: AbortSignal): Promise<ScreenReconcile>
    shutdown(signal: AbortSignal): Promise<ScreenReconcile>
    dispose(owner: ScreenOwner, signal: AbortSignal): Promise<void>
}
