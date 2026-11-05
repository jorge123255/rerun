'use client'

import { isSetupAnswered } from '@rerun/contracts'
import * as React from 'react'
import type { DesktopCaptureActions } from './capture-actions'
import { buildDesktopCaptureSelections, defaultDesktopExcludedPaths, toggleDesktopExcludedPaths } from './capture-state'
import type { DesktopCapturePlanSet, DesktopCaptureSelection, DesktopCaptureWorkspace, DesktopTemplateSetup } from './types'

export type DesktopCaptureStep = 'select' | 'review' | 'done'

type CaptureAttempt = {
    plan: DesktopCapturePlanSet
    selections: DesktopCaptureSelection[]
}

export function useDesktopCaptureFlow(actions: DesktopCaptureActions) {
    const [workspaces, setWorkspaces] = React.useState<DesktopCaptureWorkspace[]>([])
    const [workspaceId, setWorkspaceIdState] = React.useState('')
    const [selectedIds, setSelectedIds] = React.useState<string[]>([])
    const [plan, setPlan] = React.useState<DesktopCapturePlanSet | null>(null)
    const [excluded, setExcluded] = React.useState<Record<string, string[]>>({})
    const [approved, setApproved] = React.useState<Record<string, boolean>>({})
    const [setups, setSetups] = React.useState<Record<string, DesktopTemplateSetup>>({})
    const [warnings, setWarnings] = React.useState<string[]>([])
    const [loadingSources, setLoadingSources] = React.useState(true)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [attempt, setAttempt] = React.useState<CaptureAttempt | null>(null)
    const listSources = React.useRef(actions.listSources)
    const sourceRequest = React.useRef(0)

    const reloadSources = React.useCallback(async () => {
        const request = ++sourceRequest.current
        setLoadingSources(true)
        setError(null)
        const result = await listSources.current()
        if (request !== sourceRequest.current) return
        if (!result.ok) setError(result.error)
        else {
            setWorkspaces(result.workspaces)
            if (result.workspaces.length === 1) setWorkspaceIdState(result.workspaces[0].id)
        }
        setLoadingSources(false)
    }, [])

    React.useEffect(() => {
        void reloadSources()
        return () => { sourceRequest.current++ }
    }, [reloadSources])

    const locked = attempt !== null
    const setWorkspaceId = (next: string) => {
        if (locked) return
        setWorkspaceIdState(next)
        setSelectedIds([])
    }
    const toggleAgent = (agentId: string) => {
        if (locked) return
        setSelectedIds(ids => ids.includes(agentId) ? ids.filter(id => id !== agentId) : [...ids, agentId])
    }
    const setSelection = (agentIds: string[]) => {
        if (!locked) setSelectedIds(agentIds)
    }
    const toggleFiles = (agentRowId: string, paths: string[], keep: boolean) => {
        if (locked) return
        const currentPlan = plan?.plans.find(item => item.agentRowId === agentRowId)
        if (!currentPlan) return
        setExcluded(current => ({
            ...current,
            [agentRowId]: toggleDesktopExcludedPaths(currentPlan, current[agentRowId] ?? [], paths, keep),
        }))
    }
    const setApproval = (agentRowId: string, next: boolean) => {
        if (!locked) setApproved(current => ({ ...current, [agentRowId]: next }))
    }
    const setSetup = (agentRowId: string, next: DesktopTemplateSetup) => {
        if (!locked) setSetups(current => ({ ...current, [agentRowId]: next }))
    }

    async function inspect() {
        if (busy || locked || !workspaceId || selectedIds.length === 0) return false
        setError(null)
        setBusy(true)
        try {
            const result = await actions.plan({ workspaceId, agentIds: selectedIds })
            if (!result.ok) {
                setError(result.error)
                return false
            }
            setPlan(result.plan)
            setExcluded(Object.fromEntries(result.plan.plans.map(item => [item.agentRowId, defaultDesktopExcludedPaths(item)])))
            setSetups(Object.fromEntries(result.plan.plans.map(item => [item.agentRowId, item.setup])))
            setApproved({})
            setAttempt(null)
            return true
        } finally {
            setBusy(false)
        }
    }

    async function capture() {
        if (busy || !plan) return false
        setError(null)
        setBusy(true)
        const pending = attempt ?? { plan, selections: buildDesktopCaptureSelections(plan.plans, excluded, setups) }
        if (!attempt) setAttempt(pending)
        try {
            const result = await actions.capture(pending)
            if (!result.ok) {
                setError(result.error)
                if (!result.uncertain) setAttempt(null)
                return false
            }
            setWarnings(result.warnings)
            setAttempt(null)
            return true
        } finally {
            setBusy(false)
        }
    }

    const plans = plan?.plans ?? []
    const approvedCount = plans.filter(item => {
        const setup = setups[item.agentRowId]
        return approved[item.agentRowId] && setup !== undefined && isSetupAnswered(setup)
    }).length

    function reset() {
        setWorkspaceIdState(workspaces.length === 1 ? workspaces[0].id : '')
        setSelectedIds([])
        setPlan(null)
        setExcluded({})
        setApproved({})
        setSetups({})
        setWarnings([])
        setError(null)
        setAttempt(null)
    }

    return {
        workspaces,
        loadingSources,
        reloadSources,
        workspaceId,
        setWorkspaceId,
        selectedIds,
        toggleAgent,
        setSelection,
        plan,
        plans,
        excluded,
        toggleFiles,
        approved,
        setApproval,
        setups,
        setSetup,
        approvedCount,
        allApproved: plans.length > 0 && approvedCount === plans.length,
        warnings,
        busy,
        locked,
        error,
        inspect,
        capture,
        reset,
    }
}

export type DesktopCaptureFlow = ReturnType<typeof useDesktopCaptureFlow>
