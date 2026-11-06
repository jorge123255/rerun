'use client'
import { AuthMethodPicker } from '@/components/services/AuthMethodPicker'
import { SERVICE_TRANSPORT_COPY, type ServiceTransportMethod } from '@rerun/contracts'
export function ServiceTransportMethodPicker({ methods, onSelect }: { methods: ServiceTransportMethod[]; onSelect(id: string): void }) {
    return <div className="min-w-0 space-y-3">
        <p className="text-sm font-medium">Authentication</p>
        <AuthMethodPicker methods={methods} onSelect={onSelect} />
        <div className="space-y-2">{methods.filter(m => m.availability !== 'supported').map(m => <p className="break-words text-xs text-muted-foreground" key={m.id}>
            {m.label || m.id}: {m.reason === 'program' || m.reason === 'environment' ? 'Requires an approved, installed local program. No package is installed automatically.' : m.reason === 'oauth' ? SERVICE_TRANSPORT_COPY['auth-needed'] : SERVICE_TRANSPORT_COPY.unsupported}
        </p>)}</div>
    </div>
}
