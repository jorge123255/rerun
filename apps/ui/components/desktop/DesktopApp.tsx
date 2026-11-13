'use client'

import { useDesktopLocale } from './DesktopLocale'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import type { ThemePreference } from '@rerun/ui/theme'
import { PARKED_ORB_SIZE } from '@rerun/ui/foreman'
import { connectionsListSchema, PROVIDER_LABELS, type ConnectionsList, type Run, type SessionSource, type TeamAgent } from '@rerun/contracts'
import { useVisibleInterval } from '@/hooks/useVisibleInterval'
import type { SettingsChange } from '@/lib/desktop/settings'
import { DesktopSettings } from './DesktopSettings'
import { DesktopLocalProfileDialog } from './DesktopLocalProfileDialog'
import { readFirstName } from '@/lib/naming/first-name'
import { desktopProfilePhotoUrl } from '@/lib/desktop/local-profile'
import { ArrowLeft, X } from 'lucide-react'
import { SidePanel } from '@/components/layout/SidePanel'
import { SIDE_PANEL_GAP, loadSidePanelWidth } from '@/lib/side-panel-width'
import { DesktopWorkspaceMenu } from './DesktopWorkspaceMenu'
import { DesktopExternalMcpDialog } from './external-mcp/DesktopExternalMcpDialog'
import { DesktopCoworkerShareLauncher, DesktopPortableCoworkerImport, DesktopServersNavigation, DesktopWorkspaceDialogStatus } from './DesktopWorkspaceDialogs'
import { DesktopWorkspaceSettings } from './DesktopWorkspaceSettings'
import { DesktopNotificationDelivery } from './DesktopNotificationDelivery'
import { DesktopMacUpdateBridge } from './DesktopMacUpdateBridge'
import { DesktopSharedData } from './DesktopSharedData'
import { DesktopBrainDialog } from './brain/pages/DesktopBrainDialog'
import { DesktopBrainProposalsPanel } from './brain/proposals/DesktopBrainProposalsPanel'
import { flushForemanDockPlacements } from '@/lib/desktop/foreman-dock'
import { flushForemanVoicesForQuit } from '@/lib/desktop/foreman-voice/quit'
import type { ForemanPlacement } from '@/lib/foreman-layout'
import { DesktopForemanDock } from './foreman/DesktopForemanDock'
import { DesktopForemanPanel, type DesktopForemanCommand } from './foreman/DesktopForemanPanel'
import { flushDesktopForemanUiSaves } from '@/lib/desktop/foreman-client'
import { createDesktopForemanConversation } from '@/lib/desktop/foreman-client/runtime-client'
import { flushDesktopForemanIntakeWrites } from '@/lib/desktop/foreman-intake'
import { flushDesktopBrainDrafts } from '@/lib/desktop/use-brain-page-draft'
import { createDesktopBrainPagesActions } from '@/lib/desktop/brain-pages'
import { countDesktopBrainProposals } from '@/lib/desktop/brain-proposals'
import { DesktopSharedFiles } from './DesktopSharedFiles'
import { DesktopBoard } from './DesktopBoard'
import { FxBoardCameraBoundary } from './fx-repairs/FxBoardCameraBoundary'
import { createFxCameraHttpPersistence } from '@/lib/desktop/fx-repairs/board-camera-client'
import { useDesktopBoardState } from './useDesktopBoardState'
import { useDesktopCreation } from './useDesktopCreation'
import { useDesktopTemplatePlacement } from './templates/useDesktopTemplatePlacement'
import type { DesktopTemplateDetail, DesktopTemplateIdentity, DesktopTemplateInstallReceipt } from './templates/types'
import { DesktopNewAgentDialog } from './DesktopNewAgentDialog'
import type { DesktopCreationIntent } from '@/lib/desktop/new-agent'
import type { DesktopBoardState } from '@/lib/desktop/spaces'
import { useBoardActivity } from './useBoardActivity'
import { useDesktopUpcomingRoutines } from './useDesktopUpcomingRoutines'
import type { DesktopAttention } from '@/lib/desktop/attention'
import { DesktopTemplateNavigation } from './templates/DesktopTemplateNavigation'
import { DesktopControlCenter } from './DesktopControlCenter'
import { DesktopShortcutsDialog } from './DesktopShortcutsDialog'
import { DesktopHelpDialog } from './help'
import { DesktopChangelog, useDesktopChangelog } from './help/DesktopChangelog'
import { DesktopNotificationsDialog } from './DesktopNotificationsDialog'
import type { DesktopConversationHit } from '@/lib/desktop/chat-search'
import type { GridPosition } from '@rerun/ui/iso-grid'
import { Button } from '@/components/ui/button'
import { DesktopChatTabs } from './DesktopChatTabs'
import type { DesktopConversationOverviewAuthority } from './coworker-overview/conversation-mount'
import type { DesktopOverviewIdentity } from '@/lib/desktop/coworker-overview/identity'
import { DesktopGettingStartedPill } from './getting-started'
import { requestDesktopGettingStartedReopen } from '@/lib/desktop/getting-started/reopen'
import type { DesktopTabLayout } from '@/lib/desktop/session-tabs'
import { pendingTabWrite } from '@/lib/desktop/tab-writes'
import { cancelDraftShutdown, freezeDesktopAdmissions, flushDesktopDrafts, forgetCoworkerDrafts, holdDraftAdmission, isDesktopQuitting, type DesktopDraftDrain } from '@/lib/desktop/draft-writes'
import { flushDesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers'
import type { DesktopRecentCoworkers } from '@/lib/desktop/recent-coworkers.schema'
import type { DesktopOpenChat } from '@/lib/desktop/control-center-chats'
import type { DesktopChatRequest } from '@/lib/desktop/chat-request'
import type { DesktopCoworkerPanel } from '@/lib/desktop/coworker-panel'
import type { DesktopCoworkerPanelRequest } from '@/lib/desktop/coworker-panel-request'

export type DesktopAgentView = { id: string; name: string; description: string; createdAt: string; updatedAt: string; position?: GridPosition | null; spaceId?: string; enabled?: boolean }
export type DesktopSessionView = {
    id: string; agentId: string; title: string; createdAt: string; updatedAt: string
    kind?: 'general' | 'thread'; firstMessage?: string | null
    source?: SessionSource; automationName?: string | null; originAgentName?: string | null; runStatus?: Run['status'] | null
    automationOutcome?: 'done' | 'nothing'
}
export type DesktopBootstrap = ConnectionsList & {
    theme: ThemePreference
    profile: { id: number; displayName: string; photoId?: string | null }
    workspace: { id: number; name: string }
    runtimeWorkspaceId?: number
    runtimeLaunchNonce?: string
    appStoreBuild?: boolean
    iconCatalogId?: string | null
    iconUploadId?: string | null
    agents: DesktopAgentView[]
    board?: DesktopBoardState
    recentCoworkers?: DesktopRecentCoworkers
}

async function json<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : 'The local service could not complete that action')
    return body as T
}

const brainActions = createDesktopBrainPagesActions(countDesktopBrainProposals)

export function DesktopApp({ initialData }: { initialData: DesktopBootstrap }) {
    const { t } = useDesktopLocale()
    const boardState = useDesktopBoardState(initialData.board)
    const [boardInteraction, setBoardInteraction] = useState(false)
    const [controlCenterOpen, setControlCenterOpen] = useState(false)
    const [shortcutsOpen, setShortcutsOpen] = useState(false)
    const [helpOpen, setHelpOpen] = useState(false)
    const [notificationsTarget, setNotificationsTarget] = useState<{ agentId: string | null } | null>(null)
    const notificationReturnFocus = useRef<HTMLElement | null>(null)
    const [sharedDataOpen, setSharedDataOpen] = useState(false)
    const [sharedFilesOpen, setSharedFilesOpen] = useState(false)
    const [externalMcpOpen, setExternalMcpOpen] = useState(false)
    const [serversOpen, setServersOpen] = useState(false)
    const [shareTarget, setShareTarget] = useState<DesktopAgentView | null>(null)
    const [importCoworkerOpen, setImportCoworkerOpen] = useState(false)
    const [runtimeWorkspaceId, setRuntimeWorkspaceId] = useState<number | null>(() => Number.isSafeInteger(initialData.runtimeWorkspaceId) && initialData.runtimeWorkspaceId! > 0 ? initialData.runtimeWorkspaceId! : null)
    const [workspaceIdentityError, setWorkspaceIdentityError] = useState<string | null>(null)
    const [workspaceIdentityAttempt, setWorkspaceIdentityAttempt] = useState(0)
    const workspaceDialogActive = externalMcpOpen || serversOpen || !!shareTarget || importCoworkerOpen
    const workspaceDialogReturnFocus = useRef<HTMLElement | null>(null)
    const workspaceDialogWasOpen = useRef(false)
    const workspaceDialogEpoch = useRef(0)
    const workspaceDialogLease = useRef({ active: workspaceDialogActive, workspaceId: runtimeWorkspaceId })
    workspaceDialogLease.current = { active: workspaceDialogActive, workspaceId: runtimeWorkspaceId }
    const workspaceMounted = useRef(true)
    const importedCoworkerReads = useRef(new Map<string, Promise<{ agents: DesktopAgentView[]; imported: DesktopAgentView } | null>>())
    useEffect(() => { workspaceMounted.current = true; return () => { workspaceMounted.current = false } }, [])
    useEffect(() => () => { workspaceDialogEpoch.current++; workspaceDialogLease.current.active = false }, [])
    useEffect(() => {
        if (workspaceDialogActive) { workspaceDialogWasOpen.current = true; return }
        if (!workspaceDialogWasOpen.current) return
        workspaceDialogWasOpen.current = false
        const target = workspaceDialogReturnFocus.current
        workspaceDialogReturnFocus.current = null
        queueMicrotask(() => { if (!isDesktopQuitting() && target?.isConnected && !target.closest('[inert]')
            && !document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')) target.focus({ preventScroll: true }) })
    }, [workspaceDialogActive])
    useEffect(() => {
        if (!workspaceDialogActive || runtimeWorkspaceId !== null) return
        const controller = new AbortController()
        setWorkspaceIdentityError(null)
        void (async () => {
            const response = await fetch('/api/desktop/settings', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
            const result = await json<{ runtimeWorkspaceId?: number }>(response)
            if (!Number.isSafeInteger(result.runtimeWorkspaceId) || result.runtimeWorkspaceId! <= 0) throw new Error('The selected workspace could not be confirmed. Reopen this workspace to continue.')
            if (!controller.signal.aborted && !isDesktopQuitting()) setRuntimeWorkspaceId(result.runtimeWorkspaceId!)
        })().catch(cause => { if (!controller.signal.aborted) setWorkspaceIdentityError(cause instanceof Error ? cause.message : 'The selected workspace could not be confirmed.') })
        return () => controller.abort()
    }, [workspaceDialogActive, runtimeWorkspaceId, workspaceIdentityAttempt])
    const [brainOpen, setBrainOpen] = useState(false)
    const [brainRefresh, setBrainRefresh] = useState(0)
    const [brainProposalOpen, setBrainProposalOpen] = useState(0)
    const [brainSlug, setBrainSlug] = useState<string | null>(null)
    useEffect(() => {
        const open = () => {
            if (creationAdmission.current.blocked || isDesktopQuitting()) return
            setBrainOpen(true); setBrainProposalOpen(value => value + 1)
        }
        window.addEventListener('rerun-desktop-open-brain', open)
        return () => window.removeEventListener('rerun-desktop-open-brain', open)
    }, [])
    const [placingCopy, setPlacingCopy] = useState(false)
    const [quitting, setQuitting] = useState(false)
    const cameraFlush = useRef<(() => Promise<boolean>) | null>(null)
    const cameraPersistence = useMemo(() => createFxCameraHttpPersistence(workspaceId => `/api/desktop/workspaces/${workspaceId}/board-camera`), [])
    const creationAdmission = useRef({ blocked: false, settingsAllowed: true })
    useEffect(() => {
        const bridge = (window as Window & { desktopApp?: {
            onBeforeQuit?: (listener: (saveDraft?: DesktopDraftDrain) => Promise<boolean>) => () => void
            onQuitCancelled?: (listener: () => void) => () => void
        } }).desktopApp
        const stop = bridge?.onBeforeQuit?.(async saveDraft => {
            freezeDesktopAdmissions()
            setControlCenterOpen(false)
            setShortcutsOpen(false)
            setNotificationsTarget(null)
            setSharedDataOpen(false)
            workspaceDialogEpoch.current++
            workspaceDialogLease.current.active = false
            setExternalMcpOpen(false)
            setServersOpen(false)
            setShareTarget(null)
            setImportCoworkerOpen(false)
            // Freeze chat admissions synchronously, then let best-effort navigation history
            // settle alongside the existing durable draft handshake.
            const cameraReady = cameraFlush.current ? await cameraFlush.current() : true
            if (!cameraReady) return false
            const dockReady = await flushForemanDockPlacements()
            const voiceReady = await flushForemanVoicesForQuit()
            // A failed voice custody drain must remain visible. Do not hide its owner or
            // notify cancellation listeners again before the user can retry or stay.
            if (!dockReady || !voiceReady) return false
            setQuitting(true)
            const [chatReady, brainReady, foremanReady, intakeReady] = await Promise.all([flushDesktopDrafts(saveDraft), flushDesktopBrainDrafts(), flushDesktopForemanUiSaves(), flushDesktopForemanIntakeWrites(), flushDesktopRecentCoworkers()])
            const ready = dockReady && voiceReady && chatReady && brainReady && foremanReady && intakeReady
            if (!ready) setQuitting(false)
            return ready
        })
        const cancel = bridge?.onQuitCancelled?.(() => { cancelDraftShutdown(); setQuitting(false) })
        return () => { stop?.(); cancel?.() }
    }, [])
    const [preference, setPreference] = useState(initialData.theme)
    const { theme, resolvedTheme, setTheme } = useTheme()
    const [themeSaving, setThemeSaving] = useState(false)
    const themeSavingRef = useRef(false)
    const themeErrorToast = useRef<string | number | undefined>(undefined)
    const [recenterSignal, setRecenterSignal] = useState(0)
    const [newBoxSignal, setNewBoxSignal] = useState(0)
    const [boxFocus, setBoxFocus] = useState<{ spaceId: string; nonce: number } | null>(null)
    const [boardFocus, setBoardFocus] = useState<{ tileId: string; nonce: number; insetRight: number } | null>(null)
    useEffect(() => {
        if (theme !== preference) setTheme(preference)
    }, [theme, preference, setTheme])
    useEffect(() => {
        if (resolvedTheme !== 'light' && resolvedTheme !== 'dark') return
        const native = (window as Window & { desktopApp?: { setAppearance?: (value: 'light' | 'dark') => void } }).desktopApp
        native?.setAppearance?.(resolvedTheme)
    }, [resolvedTheme])
    const [providers, setProviders] = useState<ConnectionsList>({ connections: initialData.connections, default: initialData.default })
    const providerRead = useRef<AbortController | null>(null)
    const refreshProviders = useCallback(async () => {
        if (providerRead.current && !providerRead.current.signal.aborted) return
        const read = new AbortController()
        providerRead.current = read
        try {
            const response = await fetch('/api/desktop/settings', { signal: read.signal, cache: 'no-store' })
            if (!response.ok) return
            const snapshot = connectionsListSchema.parse(await response.json())
            if (!read.signal.aborted) setProviders(snapshot)
        } finally {
            if (providerRead.current === read) providerRead.current = null
        }
    }, [])
    useVisibleInterval(refreshProviders, 5000, { refreshOnFocus: true })
    useEffect(() => () => providerRead.current?.abort(), [])
    const applyProviders = useCallback((snapshot: ConnectionsList) => {
        // A read begun before a settings or sign-in change must not undo that change.
        providerRead.current?.abort()
        setProviders(snapshot)
    }, [])
    const [workspaceName, setWorkspaceName] = useState(initialData.workspace.name)
    const [savedIcon, setSavedIcon] = useState({ iconCatalogId: initialData.iconCatalogId ?? null, iconUploadId: initialData.iconUploadId ?? null })
    const [workspaceSettings, setWorkspaceSettings] = useState(false)
    const [profileOpen, setProfileOpen] = useState(false)
    const [profile, setProfile] = useState(initialData.profile)
    const [settings, setSettings] = useState(false)
    const [settingsTab, setSettingsTab] = useState<'AI providers' | 'Tool services'>('AI providers')
    const [settingsConnection, setSettingsConnection] = useState<string | null>(null)
    const [templatesOpen, setTemplatesOpen] = useState(false)
    const [templateFlowActive, setTemplateFlowActive] = useState(false)
    const [templateToReview, setTemplateToReview] = useState<DesktopTemplateIdentity | null>(null)
    const templatesActive = templatesOpen || templateFlowActive
    const [agents, setAgents] = useState(initialData.agents)
    const foremanMentionTargets = useMemo(() => {
        const boxNames = new Map(boardState.board?.spaces.map(box => [box.id, box.name]))
        const boxesByAgent = new Map(boardState.board?.placements.map(placement => [placement.agentId, placement.spaceId]))
        return agents.map(agent => ({
            agentId: agent.id, name: agent.name, handle: null,
            boxName: boxNames.get(boxesByAgent.get(agent.id) ?? agent.spaceId ?? '') ?? null,
            enabled: agent.enabled !== false, callable: false,
        }))
    }, [agents, boardState.board])
    const boardActivity = useBoardActivity(agents.map(agent => agent.id))
    const foremanTeam = useMemo<TeamAgent[]>(() => agents.filter(agent => agent.enabled !== false).map(agent => ({
        id: agent.id, name: agent.name, handle: null, status: boardActivity.statuses[agent.id] ?? 'unknown', disabledAt: null,
    })), [agents, boardActivity.statuses])
    const upcoming = useDesktopUpcomingRoutines(runtimeWorkspaceId, initialData.runtimeLaunchNonce, foremanTeam.map(agent => agent.id), !quitting)
    const { routineCountdowns, nextRoutine } = useMemo(() => {
        const upcomingByOwner = new Map(upcoming?.routines.map(routine => [routine.agentId, routine]))
        const routineCountdowns = new Map<string, { at: number }>()
        let nextRoutine: { name: string; at: number } | undefined
        for (const agent of foremanTeam) {
            const routine = upcomingByOwner.get(agent.id)
            if (!routine) continue
            routineCountdowns.set(agent.id, { at: routine.at })
            if (!nextRoutine || routine.at < nextRoutine.at) nextRoutine = routine
        }
        return { routineCountdowns, nextRoutine }
    }, [upcoming, foremanTeam])
    const foremanFirstName = readFirstName({ name: profile.displayName === 'Local User' ? '' : profile.displayName })
    // Responses already in flight cannot reintroduce a coworker after its confirmed deletion.
    const deletedAgents = useRef(new Set<string>())
    const [creating, setCreating] = useState(false)
    const [creatingSpaceId, setCreatingSpaceId] = useState<string>()
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
    const selectedAgentRef = useRef(selectedAgentId)
    selectedAgentRef.current = selectedAgentId
    const [panelOpen, setPanelOpen] = useState(false)
    const [foremanOpen, setForemanOpen] = useState(false)
    const [foremanEngaged, setForemanEngaged] = useState(false)
    const [foremanLayout, setForemanLayout] = useState<{ scope: string; open: boolean; placement: ForemanPlacement; dragging: boolean; mobile: boolean } | null>(null)
    const engageForeman = useCallback(() => { if (!isDesktopQuitting()) { setForemanEngaged(true); setForemanOpen(true) } }, [])
    const reportForemanLayout = useCallback((layout: NonNullable<typeof foremanLayout>) => setForemanLayout(old => JSON.stringify(old) === JSON.stringify(layout) ? old : layout), [])
    const foremanLeftTrack = foremanLayout?.open && !foremanLayout.dragging && !foremanLayout.mobile && foremanLayout.placement.mode === 'dock' && foremanLayout.placement.side === 'left' ? foremanLayout.placement.dockWidth : 0
    const foremanRightTrack = foremanLayout?.open && !foremanLayout.dragging && !foremanLayout.mobile && foremanLayout.placement.mode === 'dock' && foremanLayout.placement.side === 'right' ? foremanLayout.placement.dockWidth : 0
    const [foremanCommand, setForemanCommand] = useState<DesktopForemanCommand | null>(null)
    const [foremanTarget, setForemanTarget] = useState<DesktopForemanCommand['chat'] | null>(null)
    const [visibleSession, setVisibleSession] = useState<{ agentId: string; sessionId: string | null } | null>(null)
    const reportVisibleSession = useCallback((agentId: string, sessionId: string | null) => {
        if (selectedAgentRef.current !== agentId) return
        setVisibleSession(previous => previous?.agentId === agentId && previous.sessionId === sessionId ? previous : { agentId, sessionId })
    }, [])
    const [panelInsetRight, setPanelInsetRight] = useState(0)
    const boardFrame = useRef<HTMLDivElement>(null)
    const helpReturnFocus = useRef<HTMLButtonElement | null>(null)
    const panelContent = useRef<HTMLElement>(null)
    const [requestedSession, setRequestedSession] = useState<DesktopChatRequest | null>(null)
    const [requestedPanel, setRequestedPanel] = useState<DesktopCoworkerPanelRequest | null>(null)
    const panelRequestNonce = useRef(0)
    const panelRequestHandled = useCallback((request: DesktopCoworkerPanelRequest) => {
        setRequestedPanel(current => current === request ? null : current)
    }, [])
    const creation = useDesktopCreation(async (agent, sessionId, signal) => {
        signal.throwIfAborted()
        mergeBoardAgents([agent])
        const refreshed = await boardState.refresh()
        signal.throwIfAborted()
        // This response confirms the first chat. General workspace navigation must not
        // open a merely reserved coworker while its creation receipt is unresolved.
        presentCoworker(agent.id, sessionId)
        if (!refreshed && initialData.board) throw new Error('Could not refresh the created coworker’s board placement.')
    })
    const templatePlacement = useDesktopTemplatePlacement(finishTemplateInstall)
    const busy = creation.placement?.saving === true || templatePlacement.placement?.saving === true
    const creationNavigationBlocked = !!creation.placement || !!templatePlacement.placement || creation.checking || !!creation.checkError
    const creationSettingsAllowed = !creationNavigationBlocked || (!busy && (!!creation.checkError || !!creation.placement?.error))
    creationAdmission.current = { blocked: creationNavigationBlocked, settingsAllowed: creationSettingsAllowed }
    const resumedCreation = useRef<string | null>(null)
    useEffect(() => {
        const pending = creation.placement
        if (!pending || !pending.submitted || resumedCreation.current === pending.intent.requestId) return
        resumedCreation.current = pending.intent.requestId
        setCreating(false)
        setPanelOpen(false)
        setSettings(false)
    }, [creation.placement?.intent.requestId])
    const available = providers.connections.filter(c => c.connected && !c.credentialRejected)
    const defaultProvider = available.find(c => c.id === providers.default?.connectionId)
    const sidebarProvider = defaultProvider ?? available[0]
    const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? null
    const currentAgents = useRef(agents)
    currentAgents.current = agents
    const modalOrActionActive = workspaceDialogActive || templatesActive || settings || workspaceSettings || profileOpen || shortcutsOpen || helpOpen || !!notificationsTarget || sharedDataOpen || sharedFilesOpen || brainOpen || creating || !!busy || placingCopy || quitting || themeSaving || boardState.saving || creationNavigationBlocked
    const changelog = useDesktopChangelog(initialData.runtimeLaunchNonce, !modalOrActionActive && !boardInteraction && !controlCenterOpen && !panelOpen)
    const coworkerPanelBlocked = modalOrActionActive || changelog.open
    const controlCenterDisabled = coworkerPanelBlocked || boardInteraction
    const gettingStartedVisible = !controlCenterDisabled && !controlCenterOpen && !panelOpen && !foremanOpen

    useEffect(() => {
        const openFromShortcut = () => {
            if (!creationAdmission.current.settingsAllowed || workspaceDialogActive || templatesActive || shortcutsOpen || helpOpen || changelog.open
                || notificationsTarget || sharedDataOpen || sharedFilesOpen || brainOpen || workspaceSettings || profileOpen || boardInteraction
                || boardState.saving || themeSavingRef.current || isDesktopQuitting()) return false
            if (!settings) setSettingsConnection(null)
            setSettings(true)
            return true
        }
        const keydown = (event: KeyboardEvent) => {
            if (event.metaKey && event.key === ',' && openFromShortcut()) event.preventDefault()
        }
        const bridge = (window as Window & { desktopApp?: { onOpenSettings?: (listener: () => void) => () => void } }).desktopApp
        const unsubscribe = bridge?.onOpenSettings?.(openFromShortcut)
        window.addEventListener('keydown', keydown)
        return () => { unsubscribe?.(); window.removeEventListener('keydown', keydown) }
    }, [workspaceDialogActive, templatesActive, workspaceSettings, profileOpen, shortcutsOpen, helpOpen, changelog.open, notificationsTarget, sharedDataOpen, sharedFilesOpen, brainOpen, boardInteraction, boardState.saving, settings])

    useEffect(() => {
        if (panelOpen && !settings && !requestedPanel && !workspaceDialogLease.current.active) panelContent.current?.focus({ preventScroll: true })
    }, [panelOpen, selectedAgentId, requestedSession, settings])

    useEffect(() => {
        const panel = panelContent.current?.closest<HTMLElement>('[data-side-panel]')
        if (!panelOpen || !panel) return
        const wide = window.matchMedia('(min-width: 768px)')
        const measure = () => setPanelInsetRight(wide.matches ? panel.offsetWidth + SIDE_PANEL_GAP : 0)
        const observer = new ResizeObserver(measure)
        observer.observe(panel)
        measure()
        wide.addEventListener('change', measure)
        return () => { observer.disconnect(); wide.removeEventListener('change', measure) }
    }, [panelOpen])

    async function saveSettings(change: SettingsChange) {
        const response = await fetch('/api/desktop/settings', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(change),
        })
        applyProviders(await json<ConnectionsList>(response))
        if (change.action === 'appearance') setPreference(change.theme)
        if (change.action === 'workspace') setWorkspaceName(change.name)
    }

    async function saveThemeFromControlCenter(next: 'light' | 'dark') {
        if (creationAdmission.current.blocked || themeSavingRef.current || isDesktopQuitting()) return
        themeSavingRef.current = true
        setThemeSaving(true)
        if (themeErrorToast.current !== undefined) toast.dismiss(themeErrorToast.current)
        themeErrorToast.current = undefined
        // The existing SQLite setting, not localhost storage, must survive app restarts. Keep
        // the current appearance until persistence succeeds and include this write in Quit.
        const release = holdDraftAdmission()
        try { await saveSettings({ action: 'appearance', theme: next }) }
        catch (cause) {
            themeErrorToast.current = toast.error('Could not save theme.', {
                description: cause instanceof Error ? cause.message : 'Try again.',
                action: { label: 'Retry', onClick: () => { void saveThemeFromControlCenter(next) } },
            })
        } finally {
            themeSavingRef.current = false
            setThemeSaving(false)
            release()
        }
    }

    function prepareCoworker(intent: DesktopCreationIntent) {
        // Like Rerun's startScratchAgent, dismiss the form and write nothing until tile drop.
        creationAdmission.current = { blocked: true, settingsAllowed: false }
        const outcome = creation.begin(intent, creatingSpaceId)
        setCreating(false)
        setPanelOpen(false)
        return outcome
    }

    async function renameCoworker(id: string, name: string) {
        const { agent } = await json<{ agent: DesktopAgentView }>(await fetch(`/api/desktop/agents/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
        }))
        mergeBoardAgents([agent])
    }

    async function setCoworkerEnabled(id: string, enabled: boolean) {
        const { agent } = await json<{ agent: DesktopAgentView }>(await fetch(`/api/desktop/agents/${encodeURIComponent(id)}/enabled`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled }),
        }))
        mergeBoardAgents([agent])
    }

    async function deleteCoworker(id: string, confirmationName: string) {
        const result = await json<{ deletedAgentId: string }>(await fetch(`/api/desktop/agents/${encodeURIComponent(id)}`, {
            method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmationName }),
        }))
        if (result.deletedAgentId !== id) throw new Error('Could not confirm this coworker was deleted. Try again.')
        deletedAgents.current.add(id)
        forgetCoworkerDrafts(id)
        setAgents(current => current.filter(agent => agent.id !== id))
        if (selectedAgentRef.current === id) {
            selectedAgentRef.current = null
            setSelectedAgentId(null)
            setRequestedSession(null)
            setPanelOpen(false)
            setPanelInsetRight(0)
        }
        await boardState.refresh()
    }

    async function duplicateCoworker(id: string, requestId: string, position: GridPosition, spaceId?: string): Promise<'created' | 'occupied'> {
        const response = await fetch(`/api/desktop/agents/${encodeURIComponent(id)}/duplicate`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, position, ...(spaceId && { spaceId }) }),
        })
        if (response.status === 409 && (await response.clone().json().catch(() => null))?.code === 'position_occupied') {
            const { agents: latest } = await json<{ agents: DesktopAgentView[] }>(await fetch('/api/desktop/agents', { cache: 'no-store' }))
            mergeBoardAgents(latest)
            await boardState.refresh()
            return 'occupied'
        }
        const { agent } = await json<{ agent: DesktopAgentView }>(response)
        mergeBoardAgents([agent])
        await boardState.refresh()
        selectCoworker(agent.id)
        return 'created'
    }

    function mergeBoardAgents(incoming: DesktopAgentView[]) {
        setAgents(current => {
            const merged = new Map(current.map(agent => [agent.id, agent]))
            for (const agent of incoming) {
                if (deletedAgents.current.has(agent.id)) continue
                const existing = merged.get(agent.id)
                if (!existing || existing.updatedAt <= agent.updatedAt) merged.set(agent.id, agent)
            }
            return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        })
    }

    const overviewScope = useRef({ workspaceId: runtimeWorkspaceId, ownerId: String(initialData.profile.id), launchNonce: initialData.runtimeLaunchNonce })
    overviewScope.current = { workspaceId: runtimeWorkspaceId, ownerId: String(initialData.profile.id), launchNonce: initialData.runtimeLaunchNonce }
    const overviewBox = boardState.board?.placements.find(placement => placement.agentId === selectedAgent?.id)?.spaceId
    const overview: DesktopConversationOverviewAuthority | undefined = selectedAgent && runtimeWorkspaceId !== null &&
        initialData.runtimeLaunchNonce && overviewBox && boardState.board && !boardState.error && initialData.profile.id > 0
        ? {
            identity: { ownerId: String(initialData.profile.id), workspaceId: runtimeWorkspaceId, agentId: selectedAgent.id },
            boxes: boardState.board.spaces,
            canManage: !controlCenterDisabled,
            onRename: async (source, name) => {
                if (!currentOverview(source)) throw new Error('This coworker is no longer active.')
                await renameCoworker(source.agentId, name)
            },
            onRenamed: (source, name) => {
                if (currentOverview(source)) setAgents(agents => agents.map(agent => agent.id === source.agentId ? { ...agent, name } : agent))
            },
            onShare: () => {
                if (!currentOverview({ ownerId: String(initialData.profile.id), workspaceId: runtimeWorkspaceId, agentId: selectedAgent.id })) return
                const agent = currentAgents.current.find(candidate => candidate.id === selectedAgent.id)
                if (agent) { rememberWorkspaceDialogFocus(agent.id); setShareTarget(agent) }
            },
            onDelete: async (source, name) => {
                if (!currentOverview(source)) throw new Error('This coworker is no longer active.')
                await deleteCoworker(source.agentId, name)
            },
        } : undefined
    function currentOverview(source: DesktopOverviewIdentity) {
        const scope = overviewScope.current
        return !isDesktopQuitting() && !creationAdmission.current.blocked && !workspaceDialogLease.current.active &&
            scope.launchNonce === initialData.runtimeLaunchNonce && scope.ownerId === source.ownerId && scope.workspaceId === source.workspaceId &&
            selectedAgentRef.current === source.agentId && !deletedAgents.current.has(source.agentId) &&
            currentAgents.current.some(agent => agent.id === source.agentId)
    }

    function showBoard(create = false, spaceId?: string) {
        if (workspaceDialogActive || isDesktopQuitting()) return
        if (create && (creationAdmission.current.blocked || isDesktopQuitting())) return
        setRequestedPanel(null)
        setSettings(false)
        setForemanOpen(false)
        setCreating(create)
        setCreatingSpaceId(create ? spaceId : undefined)
        setPanelOpen(false)
    }

    function beginTemplatePlacement(template: DesktopTemplateDetail, again: boolean) {
        if (creationAdmission.current.blocked || boardState.saving || boardInteraction || isDesktopQuitting()) return
        if (!templatePlacement.begin(template, again)) return
        setTemplatesOpen(false)
        setTemplateToReview(null)
        showBoard()
    }

    function reviewTemplate(template: { templateId: string; revision: string }) {
        if (creationAdmission.current.blocked || workspaceDialogActive || isDesktopQuitting()) return
        setTemplateToReview(template)
        setTemplatesOpen(true)
    }

    function reviewTemplatePlacement() {
        const target = templatePlacement.review()
        if (!target) return
        setTemplateToReview(target)
        setTemplatesOpen(true)
    }

    async function finishTemplateInstall(receipt: DesktopTemplateInstallReceipt, selectedAtInstall = selectedAgentRef.current) {
        const fromPlacement = templatePlacement.placement !== null
        const firstId = receipt.coworkers[0]?.id
        const result = await json<{ agents: DesktopAgentView[] }>(await fetch('/api/desktop/agents', { cache: 'no-store', signal: AbortSignal.timeout(15_000) }))
        if (isDesktopQuitting()) return
        const first = result.agents.find(agent => agent.id === firstId)
        if (firstId && !first) throw new Error('The installed coworker could not be read from the board yet.')
        mergeBoardAgents(result.agents)
        const refreshed = await boardState.refresh()
        if (boardState.board && !refreshed) throw new Error('The installed coworker’s board position could not be refreshed yet.')
        if (!first || selectedAgentRef.current !== selectedAtInstall || (!fromPlacement && creationAdmission.current.blocked) || isDesktopQuitting() || deletedAgents.current.has(first.id)) return
        setBoardFocus(current => ({ tileId: first.id, nonce: (current?.nonce ?? 0) + 1,
            insetRight: window.matchMedia('(min-width: 768px)').matches ? loadSidePanelWidth(window.innerWidth) + SIDE_PANEL_GAP : 0 }))
        // Only an acknowledged install bypasses the placement navigation gate. Opening the
        // fresh chat reads setup; it never sends a message or enables the copied coworker.
        presentCoworker(first.id)
    }

    function closePanel() {
        setRequestedPanel(null)
        setPanelOpen(false)
        const tile = Array.from(boardFrame.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? [])
            .find(element => element.dataset.tileId === selectedAgentId)
        tile?.focus({ preventScroll: true })
    }

    function selectCoworker(agentId: string, sessionId: string | null = null, openChat?: DesktopOpenChat) {
        if (creationAdmission.current.blocked || workspaceDialogActive) return
        presentCoworker(agentId, sessionId, openChat)
    }

    // Called by general selection only after admission, or by the exact confirmed creation result.
    function presentCoworker(agentId: string, sessionId: string | null = null, openChat?: DesktopOpenChat) {
        if (isDesktopQuitting() || deletedAgents.current.has(agentId)) return
        setRequestedPanel(null)
        setSettings(false)
        setCreating(false)
        setForemanOpen(false)
        selectedAgentRef.current = agentId
        setSelectedAgentId(agentId)
        setPanelOpen(true)
        setRequestedSession(openChat ? { tabUid: openChat.tabUid, sessionId: openChat.sessionId } : sessionId ? { id: sessionId } : null)
    }

    function focusFromControlCenter(agentId: string) {
        if (!creationAdmission.current.blocked && currentAgents.current.some(agent => agent.id === agentId) && !isDesktopQuitting())
            setBoardFocus(current => ({ tileId: agentId, nonce: (current?.nonce ?? 0) + 1,
                // Match the original IsoBoard: the first opening has no measured panel yet.
                insetRight: window.matchMedia('(min-width: 768px)').matches ? loadSidePanelWidth(window.innerWidth) + SIDE_PANEL_GAP : 0 }))
    }

    function openCoworkerPanel(agentId: string, panel: DesktopCoworkerPanel, source: 'control-center' | 'board-menu' = 'control-center') {
        if (creationAdmission.current.blocked || coworkerPanelBlocked || (source === 'board-menu' ? controlCenterOpen : boardInteraction)
            || isDesktopQuitting() || deletedAgents.current.has(agentId)
            || !currentAgents.current.some(agent => agent.id === agentId)) return
        selectCoworker(agentId)
        setRequestedPanel({ agentId, panel, nonce: ++panelRequestNonce.current })
    }
    const openBoardCoworkerSettings = (agentId: string) => openCoworkerPanel(agentId, 'settings', 'board-menu')

    const askForeman = useCallback(async (chat: DesktopForemanCommand['chat'], text: string, signal: AbortSignal, requestId?: string) => {
        signal.throwIfAborted()
        if (creationAdmission.current.blocked || isDesktopQuitting()) throw new Error('The workspace is busy.')
        await new Promise<void>((resolve, reject) => {
            const id = crypto.randomUUID()
            let finished = false
            const settle = (error?: Error) => {
                if (finished) return
                finished = true; signal.removeEventListener('abort', abort)
                setForemanCommand(current => current?.id === id ? null : current)
                if (error) reject(error); else resolve()
            }
            const abort = () => settle(new Error('The Chief of Staff request was cancelled.'))
            signal.addEventListener('abort', abort, { once: true })
            setForemanTarget(current => current && current.chatId !== chat.chatId ? chat : current)
            setForemanCommand({ id, chat, text, requestId, signal, settle }); engageForeman()
        })
    }, [engageForeman])

    const openForemanConversation = useCallback(async (chat: DesktopForemanCommand['chat'] | null) => {
        const workspace = workspaceDialogLease.current.workspaceId
        const admitted = () => workspace !== null && workspaceDialogLease.current.workspaceId === workspace
            && !workspaceDialogLease.current.active && !creationAdmission.current.blocked && !isDesktopQuitting()
            && (!chat || chat.workspaceId === String(workspace))
        if (!admitted() || !await flushDesktopForemanUiSaves() || !admitted()) throw new Error('Could not leave the current Chief of Staff conversation.')
        foremanCommand?.settle(new Error('The Chief of Staff conversation changed.'))
        setForemanTarget(current => current?.chatId === chat?.chatId ? current : chat)
        engageForeman()
    }, [engageForeman, foremanCommand])

    const quickAskAdmission = useRef(false)
    quickAskAdmission.current = !controlCenterDisabled
    const quickAsk = useRef(async (_value: { requestId: string; prompt: string }) => false)
    quickAsk.current = async ({ requestId, prompt }) => {
        const workspace = workspaceDialogLease.current.workspaceId
        const current = () => workspace !== null && workspaceDialogLease.current.workspaceId === workspace
            && quickAskAdmission.current && !isDesktopQuitting()
        if (!current()) return false
        const chat = await createDesktopForemanConversation(String(workspace), requestId, AbortSignal.timeout(10_000), prompt)
        if (!current()) return false
        await openForemanConversation(chat)
        if (!current()) return false
        setRequestedPanel(null)
        setPanelOpen(false)
        setControlCenterOpen(false)
        // The native window can close once this chat owns the saved prompt. If the
        // provider refuses the run, the conversation exposes the usual exact retry.
        void askForeman(chat, '', AbortSignal.timeout(45_000), requestId).catch(error => {
            if (current()) toast.error(error instanceof Error ? error.message : 'Could not ask your Chief of Staff.')
        })
        return true
    }
    useEffect(() => {
        const bridge = (window as Window & { desktopApp?: {
            onQuickAsk?: (listener: (value: { requestId: string; prompt: string }) => Promise<boolean>) => () => void
        } }).desktopApp
        return bridge?.onQuickAsk?.(value => quickAsk.current(value))
    }, [])

    async function openCoworkerChat(target: { agentId: string; sessionId: string }) {
        const workspaceId = workspaceDialogLease.current.workspaceId
        const available = () => !creationAdmission.current.blocked && !workspaceDialogLease.current.active
            && workspaceDialogLease.current.workspaceId === workspaceId && !isDesktopQuitting()
            && !deletedAgents.current.has(target.agentId) && currentAgents.current.some(agent => agent.id === target.agentId)
        if (!available()) throw new Error('This coworker is no longer available.')
        const body = await json<{ sessions: DesktopSessionView[] }>(await fetch(`/api/desktop/agents/${encodeURIComponent(target.agentId)}/sessions`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) }))
        if (!body.sessions.some(session => session.id === target.sessionId) || !available()) throw new Error('This coworker chat is no longer available.')
        selectCoworker(target.agentId, target.sessionId)
    }

    async function openForemanCoworker(target: { agentId: string; sessionId?: string }) {
        if (creationAdmission.current.blocked || isDesktopQuitting()) return
        const result = await json<{ agents: DesktopAgentView[] }>(await fetch('/api/desktop/agents', { cache: 'no-store', signal: AbortSignal.timeout(10_000) }))
        const owner = result.agents.find(agent => agent.id === target.agentId)
        if (!owner || deletedAgents.current.has(owner.id)) throw new Error('This coworker is no longer available.')
        if (isDesktopQuitting()) return
        mergeBoardAgents(result.agents)
        await boardState.refresh()
        if (isDesktopQuitting()) return
        presentCoworker(owner.id, target.sessionId ?? null)
    }
    async function refreshForemanBoard(buildWorkspaceId: string, signal: AbortSignal) {
        const workspaceId = workspaceDialogLease.current.workspaceId
        const current = () => !signal.aborted && ownsBoardWorkspace(workspaceId)
        if (workspaceId === null || String(workspaceId) !== buildWorkspaceId || !current()) return false
        const { agents } = await json<{ agents: DesktopAgentView[] }>(await fetch('/api/desktop/agents', {
            cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }))
        if (!current() || !await boardState.refresh(signal) || !current()) return false
        mergeBoardAgents(agents)
        return true
    }
    async function openForemanBox(spaceId: string) {
        const refreshed = await boardState.refresh()
        const board = boardState.current()
        if (!refreshed || !board || isDesktopQuitting() || !board.spaces.some(space => space.id === spaceId)) throw new Error('This Box is no longer available.')
        setForemanOpen(false)
        setPanelOpen(false)
        // The original board focuses a Box through its existing container selection.
        setBoxFocus({ spaceId, nonce: Date.now() })
        setRecenterSignal(value => value + 1)
    }
    function openSavedConversation(hit: DesktopConversationHit) {
        if (currentAgents.current.some(agent => agent.id === hit.agentId)) selectCoworker(hit.agentId, hit.id)
    }

    const openSettingsAt = (tab: typeof settingsTab, connectionId: string | null = null) => {
        if (!creationAdmission.current.settingsAllowed || workspaceDialogActive || themeSavingRef.current || isDesktopQuitting()) return
        setSettingsTab(tab)
        setSettingsConnection(connectionId)
        setSettings(true)
    }
    const openSettings = () => openSettingsAt('AI providers')
    const openTranscriptionSettings = () => openSettingsAt('Tool services')
    function rememberWorkspaceDialogFocus(agentId?: string) {
        workspaceDialogReturnFocus.current = agentId
            ? Array.from(boardFrame.current?.querySelectorAll<HTMLElement>('[data-tile-id]') ?? []).find(tile => tile.dataset.tileId === agentId) ?? null
            : boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]') ?? null
    }
    function closeWorkspaceDialogs() {
        workspaceDialogEpoch.current++
        workspaceDialogLease.current.active = false
        setExternalMcpOpen(false); setServersOpen(false); setShareTarget(null); setImportCoworkerOpen(false)
    }
    const openExternalMcp = () => { if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) { rememberWorkspaceDialogFocus(); setExternalMcpOpen(true) } }
    const openServers = () => { if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) { rememberWorkspaceDialogFocus(); setServersOpen(true) } }
    const openImportCoworker = () => { if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) { rememberWorkspaceDialogFocus(); setImportCoworkerOpen(true) } }
    function ownsBoardWorkspace(workspaceId: number | null) {
        return workspaceId !== null && workspaceMounted.current && workspaceDialogLease.current.workspaceId === workspaceId && !isDesktopQuitting()
    }
    function readImportedCoworker(agentId: string, workspaceId: number | null) {
        const current = () => ownsBoardWorkspace(workspaceId)
        if (!current()) return Promise.resolve(null)
        const key = JSON.stringify([workspaceId, agentId])
        const pending = importedCoworkerReads.current.get(key)
        if (pending) return pending
        // An acknowledgement and Open can overlap. Share the canonical read so that
        // the board refresh in either path cannot cancel the other's navigation.
        const read = (async () => {
            const result = await json<{ agents: DesktopAgentView[] }>(await fetch('/api/desktop/agents', { cache: 'no-store', signal: AbortSignal.timeout(15_000) }))
            if (!current()) return null
            const imported = result.agents.find(agent => agent.id === agentId)
            if (!imported) throw new Error('The saved coworker could not be read from the board yet.')
            const refreshed = await boardState.refresh()
            if (!current()) return null
            if (initialData.board && !refreshed) throw new Error('The saved coworker’s board position could not be refreshed yet.')
            return { agents: result.agents, imported }
        })().finally(() => { importedCoworkerReads.current.delete(key) })
        importedCoworkerReads.current.set(key, read)
        return read
    }
    async function refreshImportedCoworker(agentId: string) {
        const workspaceId = runtimeWorkspaceId
        // The acknowledged copy belongs to the workspace, even if Done closes its dialog
        // before this read finishes. Closing the dialog must not select a chat or cancel it.
        const current = () => ownsBoardWorkspace(workspaceId)
        try {
            const result = await readImportedCoworker(agentId, workspaceId)
            if (result && current()) mergeBoardAgents(result.agents)
        } catch (cause) { if (current()) toast.error('The fresh copy is saved, but the board could not refresh.', { description: cause instanceof Error ? cause.message : 'Reopen this workspace to read it.' }) }
    }
    async function openImportedCoworker(agentId: string) {
        if (!workspaceDialogLease.current.active || isDesktopQuitting()) return
        const epoch = workspaceDialogEpoch.current
        const workspaceId = workspaceDialogLease.current.workspaceId
        const current = () => epoch === workspaceDialogEpoch.current && workspaceDialogLease.current.active && ownsBoardWorkspace(workspaceId)
        const selectedAtStart = selectedAgentRef.current
        try {
            const result = await readImportedCoworker(agentId, workspaceId)
            if (!result || !current()) return
            if (result.imported.enabled !== false) throw new Error('The fresh disabled coworker could not be confirmed on the board.')
            if (selectedAgentRef.current !== selectedAtStart || deletedAgents.current.has(agentId)) return
            mergeBoardAgents(result.agents)
            workspaceDialogReturnFocus.current = null
            closeWorkspaceDialogs()
            presentCoworker(agentId)
            setBoardFocus(current => ({ tileId: agentId, nonce: (current?.nonce ?? 0) + 1, insetRight: window.matchMedia('(min-width: 768px)').matches ? loadSidePanelWidth(window.innerWidth) + SIDE_PANEL_GAP : 0 }))
        } catch (cause) { if (current()) toast.error('The fresh copy is saved, but could not be opened.', { description: cause instanceof Error ? cause.message : 'Try again.' }) }
    }
    const openShortcuts = () => { if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) setShortcutsOpen(true) }
    const openHelp = (trigger?: HTMLButtonElement) => {
        if (creationAdmission.current.blocked || controlCenterDisabled || isDesktopQuitting()) return
        helpReturnFocus.current = trigger ?? null
        setHelpOpen(true)
    }
    const openNotifications = (agentId?: string) => {
        if (creationAdmission.current.blocked || controlCenterDisabled || isDesktopQuitting() || (agentId && !currentAgents.current.some(owner => owner.id === agentId))) return
        notificationReturnFocus.current = panelOpen
            ? panelContent.current?.querySelector<HTMLElement>('[data-desktop-tab-active="true"] textarea[id^="desktop-message"]') ?? panelContent.current
            : boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]') ?? null
        setNotificationsTarget({ agentId: agentId ?? null })
    }
    const modelLabel = defaultProvider ? providers.default?.model : undefined
    const gettingStarted = runtimeWorkspaceId !== null && initialData.runtimeLaunchNonce && <div hidden={!gettingStartedVisible} className="pointer-events-auto empty:hidden">
        <DesktopGettingStartedPill key={runtimeWorkspaceId} workspaceId={runtimeWorkspaceId} visible={gettingStartedVisible}
            onAddCoworker={() => showBoard(true)} onModelSettings={openSettings}
            onOpenSchedules={() => {
                const coworker = currentAgents.current.find(agent => agent.enabled !== false)
                if (coworker) openCoworkerPanel(coworker.id, 'scheduled')
                else showBoard(true)
            }} />
    </div>
    const workspaceMenu = <DesktopWorkspaceMenu workspaceName={workspaceName} {...savedIcon} profileName={profile.displayName} profilePhoto={desktopProfilePhotoUrl(profile.photoId)}
        navigationDisabled={creationNavigationBlocked || workspaceDialogActive || quitting} settingsDisabled={!creationSettingsAllowed || workspaceDialogActive || quitting}
        agents={agents} selected={panelOpen ? selectedAgentId : null} providerLabel={sidebarProvider && PROVIDER_LABELS[sidebarProvider.provider]}
        modelLabel={modelLabel} onBoard={() => showBoard()} onCoworker={selectCoworker} onSettings={openSettings}
        onProfile={() => { if (!controlCenterDisabled && !isDesktopQuitting()) setProfileOpen(true) }}
        onWorkspaceSettings={() => { if (!creationAdmission.current.blocked && !workspaceDialogActive && !isDesktopQuitting()) setWorkspaceSettings(true) }}
        onTemplates={() => { if (!creationAdmission.current.blocked && !workspaceDialogActive && !isDesktopQuitting()) setTemplatesOpen(true) }}
        onShortcuts={openShortcuts}
        onHelp={openHelp}
        onExternalMcp={openExternalMcp} onServers={openServers} onImportCoworker={openImportCoworker}
        onSharedData={() => { if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) setSharedDataOpen(true) }}
        onSharedFiles={() => { if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) setSharedFilesOpen(true) }}
        onBrain={() => { if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) setBrainOpen(true) }}
        onControlCenter={() => {
            if (creationAdmission.current.blocked || controlCenterDisabled) return
            boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')?.focus({ preventScroll: true })
            setControlCenterOpen(true)
        }} />

    return (
        <main className="relative flex h-dvh w-full flex-col overflow-clip bg-frame text-foreground md:p-2">
            <DesktopMacUpdateBridge />
            <div ref={boardFrame} data-desktop-board-frame inert={settings}
                style={{ '--desktop-idle-orb-width': !controlCenterDisabled && !panelOpen && !foremanEngaged ? `${PARKED_ORB_SIZE + 8}px` : '0px' } as CSSProperties} aria-hidden={settings || undefined}
                className="relative isolate flex min-h-0 flex-1 overflow-clip bg-background md:rounded-3xl md:border md:border-border md:shadow [--desktop-board-edge:16px] md:[--desktop-board-edge:25px]">
                {runtimeWorkspaceId != null ? <FxBoardCameraBoundary workspaceId={runtimeWorkspaceId} currentWorkspace={() => runtimeWorkspaceId} persistence={cameraPersistence} bindFlush={flush => { cameraFlush.current = flush }}>{camera => (
                <DesktopBoard activitySnapshot={boardActivity} routineCountdowns={routineCountdowns} agents={agents} workspaceName={workspaceName} workspaceMenu={workspaceMenu} gettingStarted={gettingStarted} recenterSignal={recenterSignal}
                    workspaceId={runtimeWorkspaceId} launchNonce={initialData.runtimeLaunchNonce} onOpenNotificationSettings={openNotifications}
                    cameraMountKey={camera.mountKey} initialCamera={camera.initialCamera} onCameraChange={camera.onCameraChange}
                    newBoxSignal={newBoxSignal} focusRequest={boardFocus} boxFocusRequest={boxFocus}
                    board={boardState.board} onBoardCommand={initialData.board ? boardState.command : undefined}
                    boardSaving={boardState.saving} boardError={boardState.error} onRetryBoard={boardState.retry}
                    newCoworker={creation.placement} onPlaceCoworker={creation.place} onCancelCoworker={creation.cancel}
                    templatePlacement={templatePlacement.placement} onPlaceTemplate={templatePlacement.place} onCancelTemplate={templatePlacement.cancel} onReviewTemplate={reviewTemplatePlacement}
                    creationChecking={creation.checking} creationError={creation.checkError} onRetryCreation={creation.refresh}
                    boardDisabled={workspaceDialogActive || templatesActive || settings || workspaceSettings || profileOpen || shortcutsOpen || !!notificationsTarget || sharedDataOpen || sharedFilesOpen || brainOpen || creating || controlCenterOpen || !!busy || quitting || themeSaving}
                    onBoardInteractionChange={setBoardInteraction}
                    visibleSessionId={panelOpen && !workspaceDialogActive && !templatesActive && !settings && !workspaceSettings && !profileOpen && !shortcutsOpen && !notificationsTarget && !sharedDataOpen && !sharedFilesOpen && !brainOpen && !creating && !controlCenterOpen && !busy && !boardInteraction && visibleSession?.agentId === selectedAgentId ? visibleSession.sessionId : null}
                    selectedAgentId={panelOpen ? selectedAgentId : null} panelInsetLeft={panelOpen ? 0 : foremanLeftTrack} panelInsetRight={panelOpen ? panelInsetRight : foremanRightTrack} onOpen={selectCoworker}
                    onOpenSettings={openBoardCoworkerSettings}
                    onRename={renameCoworker} onShare={agent => { if (!creationAdmission.current.blocked && !workspaceDialogActive && !isDesktopQuitting() && currentAgents.current.some(current => current.id === agent.id)) { rememberWorkspaceDialogFocus(agent.id); setShareTarget(agent) } }} onDuplicate={duplicateCoworker} onSetEnabled={setCoworkerEnabled} onDelete={deleteCoworker}
                    onCreate={spaceId => showBoard(true, spaceId)} onDismiss={() => showBoard()} onOpenConversation={openSavedConversation} onPlacementChange={setPlacingCopy} />
                )}</FxBoardCameraBoundary> : <DesktopBoard activitySnapshot={boardActivity} routineCountdowns={routineCountdowns} agents={agents} workspaceName={workspaceName} workspaceMenu={workspaceMenu} gettingStarted={gettingStarted} recenterSignal={recenterSignal}
                    newBoxSignal={newBoxSignal} focusRequest={boardFocus} boxFocusRequest={boxFocus}
                    board={boardState.board} onBoardCommand={initialData.board ? boardState.command : undefined}
                    boardSaving={boardState.saving} boardError={boardState.error} onRetryBoard={boardState.retry}
                    newCoworker={creation.placement} onPlaceCoworker={creation.place} onCancelCoworker={creation.cancel}
                    templatePlacement={templatePlacement.placement} onPlaceTemplate={templatePlacement.place} onCancelTemplate={templatePlacement.cancel} onReviewTemplate={reviewTemplatePlacement}
                    creationChecking={creation.checking} creationError={creation.checkError} onRetryCreation={creation.refresh}
                    boardDisabled={workspaceDialogActive || templatesActive || settings || workspaceSettings || profileOpen || shortcutsOpen || !!notificationsTarget || sharedDataOpen || sharedFilesOpen || brainOpen || creating || controlCenterOpen || !!busy || quitting || themeSaving}
                    onBoardInteractionChange={setBoardInteraction}
                    visibleSessionId={panelOpen && !workspaceDialogActive && !templatesActive && !settings && !workspaceSettings && !profileOpen && !shortcutsOpen && !notificationsTarget && !sharedDataOpen && !sharedFilesOpen && !brainOpen && !creating && !controlCenterOpen && !busy && !boardInteraction && visibleSession?.agentId === selectedAgentId ? visibleSession.sessionId : null}
                    selectedAgentId={panelOpen ? selectedAgentId : null} panelInsetLeft={panelOpen ? 0 : foremanLeftTrack} panelInsetRight={panelOpen ? panelInsetRight : foremanRightTrack} onOpen={selectCoworker}
                    onOpenSettings={openBoardCoworkerSettings}
                    onRename={renameCoworker} onShare={agent => { if (!creationAdmission.current.blocked && !workspaceDialogActive && !isDesktopQuitting() && currentAgents.current.some(current => current.id === agent.id)) { rememberWorkspaceDialogFocus(agent.id); setShareTarget(agent) } }} onDuplicate={duplicateCoworker} onSetEnabled={setCoworkerEnabled} onDelete={deleteCoworker}
                    onCreate={spaceId => showBoard(true, spaceId)} onDismiss={() => showBoard()} onOpenConversation={openSavedConversation} onPlacementChange={setPlacingCopy} />}
                {!controlCenterDisabled && !panelOpen && !foremanEngaged && <DesktopForemanDock open={foremanOpen} onToggle={engageForeman} />}
                {foremanEngaged && <div className="pointer-events-none absolute inset-2 z-40 grid min-h-0" style={{ gridTemplateColumns: `${foremanLeftTrack}px minmax(0,1fr) ${foremanRightTrack}px` }}>

                    <DesktopForemanPanel key={foremanTarget?.chatId ?? 'home'} target={foremanTarget}
                        onSelectConversation={runtimeWorkspaceId !== null ? openForemanConversation : undefined}
                        controlledOpen={foremanOpen} onOpenChange={setForemanOpen} onLayout={reportForemanLayout} mentionTargets={foremanMentionTargets} team={foremanTeam} firstName={foremanFirstName} nextRoutine={nextRoutine} routineNow={upcoming?.now}
                        hidden={controlCenterDisabled || (controlCenterOpen && foremanOpen) || panelOpen || settings || workspaceSettings || profileOpen || shortcutsOpen || !!notificationsTarget || sharedDataOpen || sharedFilesOpen || brainOpen || quitting}
                        findEnabled={foremanOpen && !panelOpen && !controlCenterDisabled}
                        centerOpen={controlCenterOpen} onOpenTranscriptionSettings={openTranscriptionSettings} command={foremanCommand} className="pointer-events-auto h-full min-h-0" onClose={() => { foremanCommand?.settle(new Error('The Chief of Staff chat was closed.')); setForemanOpen(false) }}
                        onOpenCoworker={openForemanCoworker} onOpenCalledChat={openCoworkerChat} onOpenBox={openForemanBox} onBuildCompleted={refreshForemanBoard}
                        onReviewTemplate={reviewTemplate} providers={providers} onOpenModelSettings={openSettings}
                        onReconnectConnection={connectionId => openSettingsAt('AI providers', connectionId)}
                        agentNameOf={id => currentAgents.current.find(agent => agent.id === id)?.name ?? 'Coworker'} />
                </div>}
                {selectedAgent && <div inert={!panelOpen || boardInteraction || workspaceDialogActive} aria-hidden={!panelOpen || boardInteraction || workspaceDialogActive || undefined}>
                    <SidePanel isOpen={panelOpen} onDismiss={closePanel}>
                        <section ref={panelContent} tabIndex={-1} data-testid="desktop-coworker-chat" aria-label={t('coworkerChat')} className="flex h-full min-h-0 flex-col outline-none"
                            onKeyDown={event => {
                                if (event.key === 'Escape' && !event.defaultPrevented && event.currentTarget.contains(event.target as Node)) {
                                    event.preventDefault()
                                    closePanel()
                                }
                            }}>
                            <CoworkerChat workspaceId={runtimeWorkspaceId} attention={boardActivity.attention} onOpenCoworkerChat={openCoworkerChat} key={selectedAgent.id} agent={overview ? { ...selectedAgent, spaceId: overviewBox } : selectedAgent} overview={overview} requested={requestedSession} selected={panelOpen && !workspaceDialogActive && !templatesActive && !settings && !workspaceSettings && !profileOpen && !shortcutsOpen && !notificationsTarget && !sharedDataOpen && !sharedFilesOpen && !brainOpen && !boardInteraction}
                                requestedPanel={requestedPanel?.agentId === selectedAgent.id ? requestedPanel : null} onPanelRequestHandled={panelRequestHandled}
                                onVisibleSession={reportVisibleSession}
                                onClosePanel={closePanel} modelLabel={modelLabel} workspaceDefault={providers.default} connections={providers.connections} onOpenModelSettings={openSettings} onOpenTranscriptionSettings={openTranscriptionSettings} />
                        </section>
                    </SidePanel>
                </div>}
            </div>
            {settings && <div className="absolute inset-0 z-50 flex flex-col bg-background md:m-2 md:overflow-hidden md:rounded-3xl md:border">
                <div className="border-b px-4 py-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setSettings(false)}><ArrowLeft />{panelOpen ? t('backToChat') : t('board')}</Button>
                </div>
                <DesktopSettings key={JSON.stringify([settingsTab, settingsConnection])} initialTab={settingsTab}
                    initialConnectionId={settingsConnection} providers={providers} workspaceName={workspaceName} onSave={saveSettings} onProviders={applyProviders}
                    workspaceId={runtimeWorkspaceId} appStoreBuild={initialData.appStoreBuild} onConnectionsChanged={() => { void refreshProviders() }} />
            </div>}
            <DesktopTemplateNavigation open={templatesOpen} onOpenChange={setTemplatesOpen} onActiveChange={setTemplateFlowActive} onCreateFromScratch={() => showBoard(true)}
                requestedTemplate={templateToReview} onPlaceTemplate={beginTemplatePlacement} onInstalled={receipt => {
                    setTemplatesOpen(false)
                    const selectedAtInstall = selectedAgentRef.current
                    void finishTemplateInstall(receipt, selectedAtInstall).catch(cause => toast.error('Coworkers were installed, but the board could not refresh.', {
                        description: cause instanceof Error ? cause.message : 'Try again.',
                        action: { label: 'Retry', onClick: () => { void finishTemplateInstall(receipt, selectedAtInstall).catch(() => boardState.retry()) } },
                    }))
                }} />
            <DesktopNewAgentDialog open={creating} onOpenChange={setCreating} onCreate={prepareCoworker} first={!agents.length}
                resolvingReceipt={creation.checking} />
            <DesktopLocalProfileDialog open={profileOpen} onOpenChange={setProfileOpen} profile={profile} onSaved={setProfile} />
            <DesktopWorkspaceSettings open={workspaceSettings} onOpenChange={setWorkspaceSettings} workspaceName={workspaceName}
                onSaved={saved => { setWorkspaceName(saved.name); setSavedIcon({ iconCatalogId: saved.iconCatalogId ?? null, iconUploadId: saved.iconUploadId ?? null }) }} />
            {workspaceDialogActive && runtimeWorkspaceId === null && <DesktopWorkspaceDialogStatus title={shareTarget ? `Share ${shareTarget.name}` : importCoworkerOpen ? 'Import coworker' : serversOpen ? 'Servers' : 'API keys & MCP'} error={workspaceIdentityError} onClose={closeWorkspaceDialogs} onRetry={() => setWorkspaceIdentityAttempt(value => value + 1)} />}
            {runtimeWorkspaceId !== null && externalMcpOpen && <DesktopExternalMcpDialog workspaceId={runtimeWorkspaceId} open onOpenChange={next => { if (!next) closeWorkspaceDialogs() }} />}
            {runtimeWorkspaceId !== null && serversOpen && <DesktopServersNavigation key={runtimeWorkspaceId} workspaceId={runtimeWorkspaceId} onClose={closeWorkspaceDialogs} />}
            {runtimeWorkspaceId !== null && shareTarget && <DesktopCoworkerShareLauncher key={`${runtimeWorkspaceId}:${shareTarget.id}`} workspaceId={runtimeWorkspaceId} agentId={shareTarget.id} agentName={shareTarget.name} onClose={closeWorkspaceDialogs} onImported={refreshImportedCoworker} onOpenCoworker={agentId => { void openImportedCoworker(agentId) }} />}
            {runtimeWorkspaceId !== null && importCoworkerOpen && <DesktopPortableCoworkerImport key={runtimeWorkspaceId} workspaceId={runtimeWorkspaceId} onClose={closeWorkspaceDialogs} onImported={refreshImportedCoworker} onOpenCoworker={agentId => { void openImportedCoworker(agentId) }} />}
            <DesktopNotificationDelivery
                navigationBlocked={controlCenterDisabled || controlCenterOpen}
                visibleSessionId={panelOpen && !workspaceDialogActive && !templatesActive && !settings && !workspaceSettings && !profileOpen && !shortcutsOpen && !notificationsTarget && !sharedDataOpen && !sharedFilesOpen && !brainOpen && !creating && !controlCenterOpen && !busy && !boardInteraction && visibleSession?.agentId === selectedAgentId ? visibleSession.sessionId : null}
                onOpenConversation={target => {
                    if (controlCenterDisabled || isDesktopQuitting() || !currentAgents.current.some(agent => agent.id === target.agentId)) return
                    focusFromControlCenter(target.agentId)
                    selectCoworker(target.agentId, target.sessionId)
                }} />
            <DesktopBrainDialog actions={brainActions} workspaceId={runtimeWorkspaceId} hideTrigger dialogControl={{open:brainOpen,onOpenChange:setBrainOpen}}
                refreshKey={brainRefresh} openProposalsKey={brainProposalOpen} openSlug={brainSlug} onOpenConsumed={()=>setBrainSlug(null)}
                renderProposals={()=><DesktopBrainProposalsPanel onOpenPage={setBrainSlug} onDecided={()=>setBrainRefresh(value=>value+1)}/>}/>
            <DesktopSharedData hideTrigger dialogControl={{ open: sharedDataOpen, onOpenChange: setSharedDataOpen }} onCloseAutoFocus={event => {
                const target = boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')
                if (target && !isDesktopQuitting()) { event.preventDefault(); target.focus({ preventScroll: true }) }
            }} />
            <DesktopSharedFiles hideTrigger workspaceId={runtimeWorkspaceId} dialogControl={{ open: sharedFilesOpen, onOpenChange: setSharedFilesOpen }} onCloseAutoFocus={event => {
                const target = boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')
                if (target && !isDesktopQuitting()) { event.preventDefault(); target.focus({ preventScroll: true }) }
            }} />
            <DesktopShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} onCloseAutoFocus={event => {
                const target = boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')
                if (target && !isDesktopQuitting()) { event.preventDefault(); target.focus({ preventScroll: true }) }
            }} />
            <DesktopChangelog state={changelog} />
            <DesktopHelpDialog open={helpOpen} onOpenChange={setHelpOpen} workspaceId={runtimeWorkspaceId}
                onGettingStarted={() => { showBoard(); requestDesktopGettingStartedReopen() }}
                onChangelog={initialData.runtimeLaunchNonce ? () => { if (!creationAdmission.current.blocked && !isDesktopQuitting()) changelog.show() } : undefined}
                onShortcuts={() => { if (!creationAdmission.current.blocked && !isDesktopQuitting()) setShortcutsOpen(true) }}
                onCloseAutoFocus={event => {
                    const trigger = helpReturnFocus.current
                    helpReturnFocus.current = null
                    const target = trigger?.isConnected && !trigger.disabled && !trigger.closest('[inert]')
                        ? trigger : boardFrame.current?.querySelector<HTMLElement>('[aria-label^="Workspace menu,"]')
                    if (target && !isDesktopQuitting()) { event.preventDefault(); target.focus({ preventScroll: true }) }
                }} />
            <DesktopNotificationsDialog open={!!notificationsTarget} pinnedCoworkerId={notificationsTarget?.agentId}
                onOpenChange={open => { if (!open) setNotificationsTarget(null) }} onCloseAutoFocus={event => {
                    event.preventDefault()
                    const target = notificationReturnFocus.current
                    notificationReturnFocus.current = null
                    queueMicrotask(() => {
                        if (!isDesktopQuitting() && target?.isConnected && !target.closest('[inert]')
                            && !document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]')) target.focus({ preventScroll: true })
                    })
                }} />
            <DesktopControlCenter activity={boardActivity} onRefreshActivity={boardActivity.refresh} coworkers={agents} selectedCoworkerId={panelOpen ? selectedAgentId : null} initialRecent={initialData.recentCoworkers}
                open={controlCenterOpen} onOpenChange={setControlCenterOpen} disabled={controlCenterDisabled}
                anchorToOrb={!foremanOpen && !panelOpen}
                board={boardState.board}
                runtimeWorkspaceId={runtimeWorkspaceId ?? undefined} runtimeLaunchNonce={initialData.runtimeLaunchNonce} onExternalMcp={openExternalMcp} onServers={openServers}
                onAddBox={initialData.board && !boardState.error ? () => { if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting()) setNewBoxSignal(signal => signal + 1) } : undefined}
                onMoveCoworker={initialData.board && !boardState.error ? (agentId, spaceId) => {
                    if (!creationAdmission.current.blocked && !controlCenterDisabled && !isDesktopQuitting() && currentAgents.current.some(agent => agent.id === agentId))
                        void boardState.command({ kind: 'move-agent', agentId, spaceId }).catch(() => {})
                } : undefined}
                onOpenCoworker={id => { if (currentAgents.current.some(agent => agent.id === id)) { focusFromControlCenter(id); selectCoworker(id) } }}
                onOpenChat={chat => { if (currentAgents.current.some(agent => agent.id === chat.agentId)) { focusFromControlCenter(chat.agentId); selectCoworker(chat.agentId, null, chat) } }}
                onOpenCoworkerSetup={agentId => { focusFromControlCenter(agentId); openCoworkerPanel(agentId, 'setup') }}
                onOpenCoworkerPanel={(agentId, panel) => { focusFromControlCenter(agentId); openCoworkerPanel(agentId, panel) }}
                onOpenConversation={hit => { focusFromControlCenter(hit.agentId); openSavedConversation(hit) }} onAddCoworker={() => showBoard(true)}
                onBrain={() => { if (!creationAdmission.current.blocked && !isDesktopQuitting()) setBrainOpen(true) }}
                onSharedFiles={() => { if (!creationAdmission.current.blocked && !isDesktopQuitting()) setSharedFilesOpen(true) }}
                onWorkspaceSettings={() => { if (!creationAdmission.current.blocked && !isDesktopQuitting()) setWorkspaceSettings(true) }}
                onRecenterBoard={() => { if (!creationAdmission.current.blocked && !isDesktopQuitting()) setRecenterSignal(signal => signal + 1) }}
                darkTheme={resolvedTheme === 'dark'}
                onToggleTheme={resolvedTheme === 'dark' || resolvedTheme === 'light' ? () => { void saveThemeFromControlCenter(resolvedTheme === 'dark' ? 'light' : 'dark') } : undefined}
                onTemplates={() => { if (!creationAdmission.current.blocked && !isDesktopQuitting()) setTemplatesOpen(true) }}
                onOpenDesktop={agentId => { if (creationAdmission.current.blocked || isDesktopQuitting() || !currentAgents.current.some(agent => agent.id === agentId && agent.enabled !== false)) return; focusFromControlCenter(agentId); selectCoworker(agentId); setRequestedPanel({ agentId, panel: 'desktop', nonce: ++panelRequestNonce.current }) }}
                onAskAssistant={askForeman}
                onShortcuts={openShortcuts} onHelp={openHelp}
                onChangelog={initialData.runtimeLaunchNonce ? () => { if (!controlCenterDisabled && !isDesktopQuitting()) changelog.show() } : undefined}
                onNotifications={openNotifications}
                onGettingStarted={runtimeWorkspaceId !== null && initialData.runtimeLaunchNonce ? () => {
                    showBoard()
                    requestDesktopGettingStartedReopen()
                } : undefined}
                onModelSettings={openSettings} onBackToBoard={() => showBoard()} />
        </main>
    )
}

function CoworkerChat({ agent, workspaceId, attention, overview, requested, requestedPanel, onPanelRequestHandled, selected, modelLabel, workspaceDefault, connections, onOpenModelSettings, onOpenTranscriptionSettings, onOpenCoworkerChat, onClosePanel, onVisibleSession }: {
    agent: DesktopAgentView
    workspaceId: number | null
    attention: DesktopAttention
    overview?: DesktopConversationOverviewAuthority
    requested: DesktopChatRequest | null
    requestedPanel: DesktopCoworkerPanelRequest | null
    onPanelRequestHandled: (request: DesktopCoworkerPanelRequest) => void
    selected: boolean
    onVisibleSession?: (agentId: string, sessionId: string | null) => void
    modelLabel?: string
    workspaceDefault: ConnectionsList['default']
    connections: ConnectionsList['connections']
    onOpenModelSettings: () => void
    onOpenTranscriptionSettings: () => void
    onOpenCoworkerChat: (target: { agentId: string; sessionId: string }) => Promise<void>
    onClosePanel: () => void
}) {
    const { t } = useDesktopLocale()
    const [sessions, setSessions] = useState<DesktopSessionView[] | null>(null)
    const pendingChatSummaries = useMemo(() => new Map(attention.items
        .filter(item => item.agentId === agent.id && item.kind !== 'info')
        .map(item => [item.sessionId, item.summary])), [agent.id, attention.items])
    const [bootstrap, setBootstrap] = useState<{ layout: DesktopTabLayout | null } | null>(null)
    const [sessionReadFailed, setSessionReadFailed] = useState(false)
    const [checkedRequest, setCheckedRequest] = useState<DesktopChatRequest | null>(null)
    const url = `/api/desktop/agents/${encodeURIComponent(agent.id)}/sessions`
    const sessionRead = useRef<AbortController | null>(null)

    const readSessions = useCallback(async ({ restoreTabs = false, checking, background = false }: {
        restoreTabs?: boolean; checking?: DesktopChatRequest; background?: boolean
    } = {}) => {
        if (background && sessionRead.current) return
        sessionRead.current?.abort()
        const controller = new AbortController()
        sessionRead.current = controller
        try {
            if (restoreTabs) await pendingTabWrite(agent.id)
            const body = await json<{ sessions: DesktopSessionView[]; tabs?: DesktopTabLayout | null }>(await fetch(background ? url + '?view=threads' : url, { signal: controller.signal, cache: 'no-store' }))
            if (controller.signal.aborted) return
            if (!Array.isArray(body.sessions)) throw new Error('Could not load conversations')
            setSessions(previous => {
                if (!background || !previous || previous.length !== body.sessions.length) return body.sessions
                return previous.every((session, index) => {
                    const next = body.sessions[index]
                    return session.id === next.id && session.agentId === next.agentId && session.title === next.title
                        && session.kind === next.kind && session.firstMessage === next.firstMessage
                        && session.createdAt === next.createdAt && session.updatedAt === next.updatedAt
                        && session.source === next.source && session.automationName === next.automationName
                        && session.originAgentName === next.originAgentName && session.runStatus === next.runStatus
                        && session.automationOutcome === next.automationOutcome
                }) ? previous : body.sessions
            })
            if (restoreTabs) setBootstrap({ layout: body.tabs ?? null })
            if (!background) setSessionReadFailed(false)
            return true
        } catch {
            if (!background && !controller.signal.aborted) setSessionReadFailed(true)
            if (!controller.signal.aborted) return false
        } finally {
            if (sessionRead.current === controller) sessionRead.current = null
            if (checking && !controller.signal.aborted) setCheckedRequest(checking)
        }
    }, [agent.id, url])
    const refreshThreads = useCallback(() => readSessions({ background: true }), [readSessions])

    useEffect(() => {
        // State changes in readSessions happen only after the asynchronous request.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void readSessions({ restoreTabs: true })
        return () => sessionRead.current?.abort()
    }, [readSessions])

    const missing = !!bootstrap && !!requested && 'id' in requested && !!sessions && !sessions.some(s => s.id === requested.id)
    useEffect(() => {
        // Webhooks, routines and coworker calls can add a chat after this panel loaded.
        // Refresh its owner-scoped list while preserving the live tab/draft instances.
        // readSessions changes state only after its asynchronous read.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (missing && requested && checkedRequest !== requested) void readSessions({ checking: requested })
    }, [missing, requested, checkedRequest, readSessions])
    const dismiss = <Button type="button" variant="ghost" size="icon-sm" aria-label={t('closePanel')} className="absolute right-3 top-3" onClick={onClosePanel}><X /></Button>
    const retryRead = () => {
        setSessionReadFailed(false)
        void readSessions({ restoreTabs: !bootstrap, checking: missing ? requested ?? undefined : undefined })
    }
    const reload = () => {
        setBootstrap(null)
        setSessionReadFailed(false)
        setCheckedRequest(null)
        void readSessions({ restoreTabs: true })
    }
    return <>
        {(sessionReadFailed || (missing && checkedRequest === requested)) && <div role="alert" className="flex flex-wrap items-center gap-2 px-5 py-2 text-sm text-destructive">
            {t(sessionReadFailed ? 'threadHistory.loadFailed' : 'savedChatUnavailable')}
            <Button type="button" size="sm" variant="outline" onClick={retryRead}>{t('retryConversations')}</Button>
        </div>}
        {missing && checkedRequest !== requested && !sessionReadFailed && <p role="status" className="px-5 py-2 text-sm text-muted-foreground">{t('openingSavedChat')}</p>}
        {!sessionReadFailed && !bootstrap && <div className="mt-auto shrink-0 border-t p-2.5">
            <div data-slot="desktop-composer" className="min-h-[5.5rem] rounded-xl border border-input bg-muted/40 px-2.5 py-2">
                <p role="status" className="text-sm text-muted-foreground">{t('openingCoworkerChat', { name: agent.name })}</p>
            </div>
        </div>}
        {!bootstrap || !sessions ? dismiss : <DesktopChatTabs workspaceId={workspaceId} onOpenCoworkerChat={onOpenCoworkerChat}
            agent={agent} overview={overview} selected={selected && !missing} requested={missing ? null : requested} requestedPanel={requestedPanel} onPanelRequestHandled={onPanelRequestHandled} pendingChatSummaries={pendingChatSummaries} sessions={sessions} initialLayout={bootstrap.layout}
            onVisibleSession={onVisibleSession}
            refreshSessions={readSessions} refreshThreads={refreshThreads} reload={reload} modelLabel={modelLabel} workspaceDefault={workspaceDefault} connections={connections} onOpenModelSettings={onOpenModelSettings} onOpenTranscriptionSettings={onOpenTranscriptionSettings} onClosePanel={onClosePanel} />}
    </>
}
