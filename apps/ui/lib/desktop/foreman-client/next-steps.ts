/** Lead setup / next-step presentation from I's build.setup + lead item. */

import type { DesktopForemanBuildProgressView } from './build-progress'

export type DesktopForemanNextStep =
    | {
          kind: 'start_lead'
          label: string
          startedLabel: string
          agentId: string
          itemKey: string
          buildId: string
          sessionId: string | null
      }
    | { kind: 'open_created'; label: string; agentId: string; boxId: string | null; sessionId: string | null }
    | { kind: 'unavailable'; label: string; reason: string }

export type DesktopLeadSetupState =
    | { status: 'idle' }
    | { status: 'starting'; agentId: string; requestId: string; itemKey: string; buildId: string }
    | { status: 'started'; agentId: string; sessionId: string }
    | { status: 'failed'; agentId: string; error: string }
    | { status: 'unavailable'; agentId: string; reason: string }

export function projectForemanNextSteps(build: DesktopForemanBuildProgressView | null): DesktopForemanNextStep[] {
    if (!build) return []
    const lead = build.items.find(item => item.lead && item.status === 'created' && item.agentId)
        ?? (build.leadItemKey ? build.items.find(item => item.itemKey === build.leadItemKey && item.agentId) : undefined)
    if (!lead?.agentId) {
        const created = build.items.find(item => item.status === 'created' && item.agentId)
        if (!created?.agentId) return []
        return [{
            kind: 'open_created',
            label: created.name ? `Open ${created.name}` : 'Open coworker',
            agentId: created.agentId,
            boxId: created.boxId,
            sessionId: created.sessionId,
        }]
    }

    if (build.setup.state === 'unavailable') {
        return [{ kind: 'unavailable', label: 'Lead setup unavailable', reason: build.setup.error || 'Lead setup is not available in this runtime.' }]
    }
    if (build.setup.state === 'started' && build.setup.agentId && build.setup.sessionId) {
        return [{
            kind: 'open_created',
            label: lead.name ? `Open ${lead.name}` : 'Open coworker',
            agentId: build.setup.agentId,
            boxId: lead.boxId,
            sessionId: build.setup.sessionId,
        }]
    }
    if (build.setup.state === 'failed' || build.setup.state === 'uncertain') {
        return [{
            kind: 'unavailable',
            label: lead.name ? `Could not start ${lead.name}` : 'Could not start lead setup',
            reason: build.setup.error || 'Lead setup failed.',
        }]
    }

    return [{
        kind: 'start_lead',
        label: lead.name ? `Start installing ${lead.name}` : 'Start installing my coworker',
        startedLabel: lead.name ? `${lead.name}'s install has started` : "Your coworker's install has started",
        agentId: lead.agentId,
        itemKey: lead.itemKey,
        buildId: build.buildId,
        sessionId: lead.sessionId,
    }]
}

/** Historical cards (live=null) must not start setup or create schedules. */
export function nextStepAllowedWhileLive(live: boolean, step: DesktopForemanNextStep): boolean {
    if (!live) return false
    return step.kind !== 'unavailable'
}
