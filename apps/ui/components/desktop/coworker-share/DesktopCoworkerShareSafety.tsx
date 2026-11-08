'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Icon } from '@/components/ui/icon'
import { ShieldCheck } from '@/lib/icons'

export function DesktopCoworkerShareSafety({ exclusions = null }: { exclusions?: readonly { path: string; reason: string }[] | null }) {
    const reasons = new Set((exclusions ?? []).map(item => item.reason))
    const listed = exclusions && exclusions.length > 0
    const credentialLine = listed && reasons.has('credentials') ? 'This archive’s exclusion list omits saved credential paths.' : listed ? 'This archive’s exclusion list does not record a credential exclusion.' : 'Credential exclusion is listed on the review from this archive’s own exclusion list.'
    const historyLine = listed && reasons.has('history') ? ' Chat history paths in that list are omitted.' : ''
    return <Alert variant="warning" stripes className="grid-cols-[auto_1fr] gap-x-3 gap-y-0">
        <Icon icon={ShieldCheck} size="sm" className="row-span-2 self-center" />
        <AlertTitle className="col-start-2 leading-tight">Review what this archive contains</AlertTitle>
        <AlertDescription className="col-start-2 leading-snug">
            {credentialLine}{historyLine} File counts follow the files that remain after reserved .rerun and .rerun-skill paths are dropped. Selected instructions, skills and files are copied as written and may contain private information. The imported copy starts disconnected with every permission off.
        </AlertDescription>
    </Alert>
}
