'use client'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Icon } from '@/components/ui/icon'
import { ShieldCheck } from '@/lib/icons'

export function DesktopCoworkerShareSafety() {
    return <Alert variant="warning" stripes className="grid-cols-[auto_1fr] gap-x-3 gap-y-0">
        <Icon icon={ShieldCheck} size="sm" className="row-span-2 self-center" />
        <AlertTitle className="col-start-2 leading-tight">Saved credentials stay here</AlertTitle>
        <AlertDescription className="col-start-2 leading-snug">
            Saved credentials, connected accounts and chat history are excluded. Selected instructions, skills and files are copied as written and may contain private information. Review them before sharing. The imported copy starts disconnected with every permission off.
        </AlertDescription>
    </Alert>
}
