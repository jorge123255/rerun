'use client'

import { WHATSAPP_STATUS_DESCRIPTION, whatsappStatusFieldCopy, whatsappStatusFieldOrder, whatsappStatusSetupCopy, type WhatsappStatusBinding } from '../../../../../packages/contracts/src/desktop-whatsapp-status.ts'

export function DesktopWhatsappStatusSetup({ binding }: { binding: WhatsappStatusBinding }) {
    const state = binding.phase === 'ready' ? whatsappStatusSetupCopy.ready : whatsappStatusSetupCopy[binding.reason]
    return <section aria-label="WhatsApp Status" className="min-w-0 space-y-3 rounded-xl border border-border bg-background p-3">
        <h2 className="text-sm font-medium">WhatsApp Status</h2>
        <p className="text-sm text-muted-foreground">{WHATSAPP_STATUS_DESCRIPTION}</p>
        <p role="status" className="text-sm">{state}</p>
        <dl className="space-y-2">
            {whatsappStatusFieldOrder.map(field => <div key={field} className="min-w-0">
                <dt className="text-xs font-medium text-muted-foreground">{field}</dt>
                <dd className="break-words text-sm">{whatsappStatusFieldCopy[field]}</dd>
            </div>)}
        </dl>
    </section>
}
