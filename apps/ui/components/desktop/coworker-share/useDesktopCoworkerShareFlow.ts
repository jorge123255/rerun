'use client'

import * as React from 'react'
import type {
    DesktopCoworkerShareExportInput,
    DesktopCoworkerShareInclude,
    DesktopCoworkerSharePlan,
    DesktopCoworkerShareReceipt,
    DesktopCoworkerShareReviewInput,
    DesktopCoworkerShareRevokeInput,
    DesktopCoworkerSnapshotResult,
} from '@rerun/contracts'
import type { DesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { isDesktopCoworkerShareResultCurrent, isDesktopCoworkerShareReviewCurrent, type DesktopCoworkerReviewedShare } from '@/lib/desktop/coworker-share/state'

const DEFAULT_INCLUDE: DesktopCoworkerShareInclude = { memories: false, database: false, files: false }

export type DesktopCoworkerShareStep = 'configure' | 'review' | 'success'
export type DesktopCoworkerExportedShare = {
    result: DesktopCoworkerSnapshotResult
    sourceRevision: string
    requestId: string
}

export function useDesktopCoworkerShareFlow({ client, attempts, workspaceId, agentId, sourceRevision, active = true }: {
    client: DesktopCoworkerShareClient
    attempts: DesktopCoworkerShareAttempts
    workspaceId: number
    agentId: string
    sourceRevision: string
    active?: boolean
}) {
    const owner = React.useMemo(() => ({ workspaceId, agentId }), [workspaceId, agentId])
    const activeRef = React.useRef(active)
    activeRef.current = active
    const latest = React.useRef({ sourceRevision, owner })
    latest.current = { sourceRevision, owner }
    const planRequest = React.useRef(0)
    const operation = React.useRef(0)
    const running = React.useRef(false)
    const [plan, setPlan] = React.useState<DesktopCoworkerSharePlan | null>(null)
    const [loading, setLoading] = React.useState(true)
    const [include, setIncludeState] = React.useState<DesktopCoworkerShareInclude>(DEFAULT_INCLUDE)
    const [step, setStep] = React.useState<DesktopCoworkerShareStep>('configure')
    const [reviewed, setReviewed] = React.useState<DesktopCoworkerReviewedShare | null>(null)
    const [approved, setApproved] = React.useState(false)
    const [exported, setExported] = React.useState<DesktopCoworkerExportedShare | null>(null)
    const [pendingExports, setPendingExports] = React.useState<DesktopCoworkerShareExportInput[]>([])
    const [pendingRevocations, setPendingRevocations] = React.useState<DesktopCoworkerShareRevokeInput[]>([])
    const [withdrawn, setWithdrawn] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)

    const refreshAttempts = React.useCallback(async () => {
        try {
            const [exports,revocations] = await Promise.all([attempts.listExport(owner),attempts.listRevocations(owner)])
            if (!activeRef.current || latest.current.owner.workspaceId !== owner.workspaceId || latest.current.owner.agentId !== owner.agentId) return
            setPendingExports(exports); setPendingRevocations(revocations)
        } catch { if (activeRef.current) setError('Durable share recovery is unavailable. Reopen the panel before a new export.') }
    }, [attempts, owner])

    React.useEffect(() => {
        if (!active) return
        const request = ++planRequest.current
        setLoading(true)
        setError(null)
        refreshAttempts()
        void client.plan().then(result => {
            if (!activeRef.current || request !== planRequest.current) return
            setPlan(result)
        }).catch((cause: unknown) => {
            if (!activeRef.current || request !== planRequest.current) return
            setError(cause instanceof Error ? cause.message : 'The coworker could not be inspected.')
        }).finally(() => {
            if (activeRef.current && request === planRequest.current) setLoading(false)
        })
        return () => { planRequest.current++ }
    }, [active, client, owner, sourceRevision, refreshAttempts])

    React.useEffect(() => {
        activeRef.current = active
        return () => {
            activeRef.current = false
            operation.current++
        }
    }, [active])

    React.useEffect(() => {
        setIncludeState(DEFAULT_INCLUDE)
        setPlan(null)
        setStep('configure')
        setReviewed(null)
        setApproved(false)
        setExported(null)
        setPendingRevocations([])
        setWithdrawn(false)
        setError(null)
        operation.current++
        running.current = false
    }, [owner])

    React.useEffect(() => {
        if (reviewed && reviewed.input.sourceRevision !== sourceRevision) setApproved(false)
    }, [reviewed, sourceRevision])

    const currentReviewInput = React.useCallback((requestId: string): DesktopCoworkerShareReviewInput => ({
        workspaceId: latest.current.owner.workspaceId,
        agentId: latest.current.owner.agentId,
        sourceRevision: latest.current.sourceRevision,
        requestId,
        include: { ...include },
    }), [include])

    const stale = React.useMemo(() => reviewed !== null && !isDesktopCoworkerShareReviewCurrent(reviewed, {
        ...reviewed.input,
        workspaceId,
        agentId,
        sourceRevision,
    }), [reviewed, workspaceId, agentId, sourceRevision])

    function setInclude(next: Partial<DesktopCoworkerShareInclude>) {
        if (step !== 'configure' || running.current) return
        setIncludeState(current => ({ ...current, ...next }))
        setError(null)
    }

    async function reviewContent(): Promise<boolean> {
        if (running.current || step === 'success') return false
        const request = ++operation.current
        running.current = true
        setBusy(true)
        setError(null)
        const input = currentReviewInput(crypto.randomUUID())
        try {
            const result = await client.review({ sourceRevision: input.sourceRevision, requestId: input.requestId, include: input.include })
            if (!activeRef.current || request !== operation.current) return false
            setReviewed({ input, result })
            setApproved(false)
            setStep('review')
            return true
        } catch (cause) {
            if (activeRef.current && request === operation.current) {
                setApproved(false)
                setError(cause instanceof Error ? cause.message : 'The current content could not be reviewed. Your choices are kept.')
            }
            return false
        } finally {
            running.current = false
            if (activeRef.current && request === operation.current) setBusy(false)
        }
    }

    async function exportShare(recovery?: DesktopCoworkerShareExportInput): Promise<boolean> {
        if (running.current || exported) return exported !== null
        if (!recovery && (!reviewed || !approved || stale || step !== 'review')) return false
        const input = recovery ?? (reviewed ? {
            ...reviewed.input,
            reviewId: reviewed.result.reviewId,
            expectedDigest: reviewed.result.manifest.contentDigest,
        } : null)
        if (!input) return false
        const request = ++operation.current
        running.current = true
        setBusy(true)
        setError(null)
        try {
            await attempts.rememberExport(input)
            await refreshAttempts()
            if (!activeRef.current || request !== operation.current) return false
            const result = await client.export(input)
            const matches = recovery
                ? result.manifest.packageKey === input.reviewId.slice(0, 32) && result.manifest.contentDigest === input.expectedDigest
                : reviewed !== null && isDesktopCoworkerShareResultCurrent(reviewed, result)
            if (!matches) throw new Error('The export acknowledgement does not match the reviewed archive. Retry this same attempt.')
            if (!activeRef.current || request !== operation.current) return false
            await attempts.forgetExport(input)
            if (!activeRef.current || request !== operation.current) return false
            setExported({ result, sourceRevision: input.sourceRevision, requestId: input.requestId })
            setReviewed(null)
            setApproved(false)
            setStep('success')
            setWithdrawn(false)
            setPendingRevocations(await attempts.listRevoke({ workspaceId: input.workspaceId, agentId: input.agentId, snapshotId: result.manifest.packageKey }))
            refreshAttempts()
            return true
        } catch (cause) {
            if (activeRef.current && request === operation.current) {
                setError(cause instanceof Error ? cause.message : 'Could not confirm the export. Retry this same attempt.')
                refreshAttempts()
            }
            return false
        } finally {
            running.current = false
            if (activeRef.current && request === operation.current) setBusy(false)
        }
    }

    async function withdraw(recovery?: DesktopCoworkerShareRevokeInput): Promise<boolean> {
        if (running.current || withdrawn) return withdrawn
        const snapshotId = recovery?.snapshotId ?? exported?.result.manifest.packageKey
        const expectedRevision = recovery?.expectedRevision ?? exported?.sourceRevision
        if (!snapshotId || !expectedRevision) return false
        const input: DesktopCoworkerShareRevokeInput = recovery ?? {
            requestId: crypto.randomUUID(),
            snapshotId,
            expectedRevision,
        }
        const scope = { workspaceId, agentId, snapshotId }
        const request = ++operation.current
        running.current = true
        setBusy(true)
        setError(null)
        try {
            await attempts.rememberRevoke(scope, input)
            setPendingRevocations(await attempts.listRevoke(scope))
            if (!activeRef.current || request !== operation.current) return false
            const receipt: DesktopCoworkerShareReceipt = await client.revoke(input)
            if (receipt.operation !== 'revoke' || receipt.status !== 'revoked' || receipt.requestId !== input.requestId || receipt.snapshotId !== input.snapshotId) {
                throw new Error('The withdrawal acknowledgement does not match this local share. Retry the same attempt.')
            }
            if (!activeRef.current || request !== operation.current) return false
            await attempts.forgetRevoke(scope, input)
            if (!activeRef.current || request !== operation.current) return false
            setPendingRevocations(await attempts.listRevoke(scope))
            setWithdrawn(true)
            return true
        } catch (cause) {
            if (activeRef.current && request === operation.current) {
                setError(cause instanceof Error ? cause.message : 'Could not confirm withdrawal. Retry this same attempt.')
                await refreshAttempts()
            }
            return false
        } finally {
            running.current = false
            if (activeRef.current && request === operation.current) setBusy(false)
        }
    }

    function cancel() {
        operation.current++
        setStep('configure')
        setReviewed(null)
        setApproved(false)
        setExported(null)
        setBusy(false)
        setError(null)
        setWithdrawn(false)
    }

    return {
        step,
        plan,
        loading,
        include,
        setInclude,
        reviewed,
        approved,
        setApproved,
        stale,
        exported,
        pendingExports,
        pendingRevocations,
        withdrawn,
        busy,
        error,
        reviewContent,
        exportShare,
        recoverExport: (input: DesktopCoworkerShareExportInput) => exportShare(input),
        withdraw,
        recoverWithdrawal: (input: DesktopCoworkerShareRevokeInput) => withdraw(input),
        cancel,
    }
}

export type DesktopCoworkerShareFlow = ReturnType<typeof useDesktopCoworkerShareFlow>
