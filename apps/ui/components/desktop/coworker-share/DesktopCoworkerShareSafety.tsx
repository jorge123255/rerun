'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Icon } from '@/components/ui/icon'
import { ShieldCheck } from '@/lib/icons'

export function DesktopCoworkerShareSafety() {
    return <Alert variant="warning" stripes className="grid-cols-[auto_1fr] gap-x-3 gap-y-0">
        <Icon icon={ShieldCheck} size="sm" className="row-span-2 self-center" />
        <AlertTitle className="col-start-2 leading-tight">Sensitive data is stripped</AlertTitle>
        <AlertDescription className="col-start-2 leading-snug">
            API keys, connected accounts and chat history never leave your workspace, whatever you pick above. Files that look like they hold a credential are dropped, and apps arrive disconnected with every permission off for whoever imports the portable file.
        </AlertDescription>
    </Alert>
}
