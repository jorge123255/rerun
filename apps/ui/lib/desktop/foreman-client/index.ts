export {
    type DesktopForemanChatRef,
    type DesktopForemanModelRef,
    type DesktopForemanBinding,
    type DesktopForemanLiveScope,
    parseDesktopForemanChatRef,
    parseDesktopForemanBinding,
    sameForemanChat,
    foremanChatKey,
    isForemanRevisionId,
    acceptsForemanReply,
    isLiveForemanView,
    isForemanId,
} from './identity'

export {
    type DesktopPlanBeats,
    type DesktopPlanItemView,
    type DesktopPlanGroupView,
    type DesktopShownPlanView,
    type DesktopTrustedPlanSnapshot,
    type DesktopPlanDecisionView,
    readTrustedPlan,
    projectPlanCard,
    planLifeScript,
    revisionToTrustedSnapshot,
} from './plan-view'

export {
    type DesktopPlanDecisionKind,
    type DesktopPlanDecisionRequest,
    type DesktopPlanDecisionStatus,
    type DesktopPlanDecisionResult,
    createPlanDecisionRequestId,
    canSubmitPlanDecision,
    projectDecisionBusy,
    beginPlanDecision,
    applyPlanDecisionResult,
    retryPlanDecisionRequest,
    clearPlanDecision,
    tabChangePreservesDecision,
} from './decision'

export {
    type DesktopForemanBuildItemStatus,
    type DesktopForemanBuildItemView,
    type DesktopForemanBuildProgressView,
    fromContractBuild,
    projectBuildProgress,
    buildItemLabel,
} from './build-progress'

export {
    type DesktopDiscoverySource,
    type DesktopDiscoveryAttribution,
    type DesktopDiscoveryFinding,
    type DesktopDiscoveryEvent,
    type DesktopDiscoveryEntry,
    type DesktopDiscoveriesState,
    EMPTY_DESKTOP_DISCOVERIES,
    DESKTOP_DISCOVERY_SOURCE_LABELS,
    DESKTOP_DISCOVERY_TEASERS,
    applyDesktopDiscoveryEvent,
    discoveriesFromRun,
    projectDiscoveriesOverlay,
} from './discovery-view'

export {
    type DesktopForemanNextStep,
    type DesktopLeadSetupState,
    projectForemanNextSteps,
    nextStepAllowedWhileLive,
} from './next-steps'

export {
    type DesktopForemanNavigationIntent,
    type DesktopForemanNavigationRequest,
    canDispatchForemanNavigation,
} from './navigation'

export {
    type DesktopForemanUiTab,
    type DesktopForemanPersistedUi,
    type DesktopForemanPlacement,
    type DesktopForemanPersistence,
    DEFAULT_DESKTOP_FOREMAN_PLACEMENT,
    projectRestoredForemanUi,
    projectTabChange,
    projectDraftChange,
    projectOpenChange,
} from './persistence'

export {
    type DesktopForemanConversationCallbacks,
    type DesktopForemanDecisionPort,
    type DesktopForemanBuildPort,
    type DesktopForemanDiscoveryPort,
    type DesktopForemanNavigationPort,
    type DesktopForemanPlanPort,
    type DesktopForemanRoutinesPort,
    type DesktopForemanActionPorts,
    requirePort,
    saveForemanUiIfMatching,
} from './actions'

export { DESKTOP_FOREMAN_CONTRACT_EXPECTATIONS } from './contract-expectations'
