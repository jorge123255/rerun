'use client'

import type { DesktopCompanyProfileView } from '@rerun/contracts'
import { companyProfilePreviewPlan, type DesktopCompanyProfilePreviewScope } from '@/lib/desktop/company-profile/preview'
import { DesktopPlanBoardPreview } from '../plan/DesktopPlanBoardPreview'
import { DesktopDiscoveryStatusPill } from '../discoveries/DesktopDiscoveryStatusPill'
import { companyProfileDomain, DesktopCompanyProfileFindings } from './DesktopCompanyProfileFindings'

export function DesktopCompanyProfileBoardPreview({ scope, view, compact = false }: {
    scope: DesktopCompanyProfilePreviewScope
    view: DesktopCompanyProfileView | null
    compact?: boolean
}) {
    const preview = companyProfilePreviewPlan(scope, {
        industry: view?.profile.industry.value ?? null,
        companyName: view?.profile.name.value,
    })
    const attempts = [view?.decision ?? null, view?.enrichment ?? null]
    const hasAnalysis = attempts.some(Boolean)
    const found = view ? [view.profile.name.value, view.profile.description.value, view.profile.offering.value, view.profile.audience.value, view.profile.industry.value].filter(Boolean).length : 0
    const digging = attempts.some(attempt => attempt?.status === 'pending')
    const name = view?.profile.name.value ?? (view ? companyProfileDomain(view.profile) : 'your company')
    return <div className="pointer-events-none absolute inset-0">
        {preview && <DesktopPlanBoardPreview key={preview.scopeKey} plan={preview.plan} className="absolute inset-0" />}
        {view && hasAnalysis && <div className="absolute inset-x-0 top-4 flex flex-col items-center gap-2 px-4">
            <DesktopDiscoveryStatusPill name={name} found={found} digging={digging} />
            {compact && <div className="w-full max-w-72"><DesktopCompanyProfileFindings profile={view.profile} limit={1} /></div>}
        </div>}
        {view && hasAnalysis && !compact && <div className="absolute -bottom-2 -right-2 flex max-h-[70%] w-72 flex-col gap-2 overflow-y-auto p-6">
            <DesktopCompanyProfileFindings profile={view.profile} />
        </div>}
    </div>
}
