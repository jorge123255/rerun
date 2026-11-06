/**
 * Named expectations for I's sole canonical contract at
 * packages/contracts/src/desktop-foreman.ts (read 2026-11-05 from round33-foreman-runtime).
 * H does not copy that file. Root exports it from @rerun/contracts; presentation maps via adapters.
 */

export const DESKTOP_FOREMAN_CONTRACT_EXPECTATIONS = {
    module: 'packages/contracts/src/desktop-foreman.ts',
    importFrom: '@rerun/contracts',
    contractVersion: 1,
    types: [
        'DesktopForemanPhase',
        'DesktopForemanModelRef',
        'DesktopForemanBinding',
        'DesktopForemanChatRef',
        'DesktopForemanPlanItem',
        'DesktopForemanPlanBox',
        'DesktopForemanShowPlanInput',
        'DesktopForemanSealedPlan',
        'DesktopForemanRevision',
        'DesktopForemanDecisionInput',
        'DesktopForemanDecision',
        'DesktopForemanBuildItem',
        'DesktopForemanBuild',
        'DesktopForemanBuildAction',
        'DesktopDiscoverySource',
        'DesktopForemanFinding',
        'DesktopForemanDiscoveryEvent',
        'DesktopForemanDiscoveryRun',
        'DesktopForemanLiveEvent',
        'DesktopForemanConversationView',
        'DesktopForemanError',
    ] as const,
    helpers: ['applyForemanDiscoveryEvent', 'DESKTOP_FOREMAN_SOURCE_LABELS', 'DESKTOP_FOREMAN_LIMITS', 'DESKTOP_FOREMAN_CONTRACT_VERSION'] as const,
    decisionStates: ['pending', 'acknowledged', 'failed', 'uncertain'] as const,
    buildStates: ['reserved', 'running', 'completed', 'partial', 'stopped', 'failed', 'uncertain'] as const,
    phases: ['discover', 'plan', 'build', 'companion'] as const,
    rules: [
        'Opaque local IDs only (fmc_/fmp_/fmr_/fmd_/fmb_); no provider credentials or host paths.',
        'Confirm/ask_changes require exact planId+revisionId+digest; prose is never approval.',
        'ConversationView.live=null means historical: no navigation, setup or discovery effects.',
        'Team creation does not automatically start every coworker; start_lead_setup is explicit.',
        'Unknown acknowledgement blocks contradictory retries via ConversationView.blocked.',
    ],
} as const
