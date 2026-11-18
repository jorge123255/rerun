import type { MacPhoneCoworkerSettingsChange } from '@rerun/mac-contracts/mac-phone-pairing'

type Intent = Extract<MacPhoneCoworkerSettingsChange, { field: 'setup' | 'box' }>

export function isReceiptChange(change: MacPhoneCoworkerSettingsChange): change is Intent {
    return change.field === 'setup' || change.field === 'box'
}

// These are admission refusals. A timeout, transport failure, 5xx or malformed acknowledgement
// can arrive after the Mac reserved the operation and must keep its original request identity.
export function isDefiniteSettingsRefusal(reason: unknown): boolean {
    const status = reason && typeof reason === 'object' && 'status' in reason ? reason.status : null
    return typeof status === 'number' && [400, 401, 403, 404, 409, 413, 422].includes(status)
}

// One cache per paired hub. Display components can reopen, or generate another UUID while a
// previous acknowledgement is missing. Only the exact coworker, command and revision resume it.
export function settingsWithReceipts(send: (agentId: string, change: MacPhoneCoworkerSettingsChange, signal?: AbortSignal) => Promise<void>) {
    const requests = new Map<string, { owner: string; change: Intent; uncertain: boolean }>()
    async function changeCoworkerSettings(agentId: string, change: MacPhoneCoworkerSettingsChange, signal?: AbortSignal): Promise<void> {
        if (!isReceiptChange(change)) return send(agentId, change, signal)
        const target = change.field === 'box' ? change.body.spaceId : change.body.action
        const key = JSON.stringify([agentId, change.field, change.body.expectedRevision, target])
        const admitted = requests.get(key) ?? { owner: agentId, change, uncertain: false }
        requests.set(key, admitted)
        try {
            await send(agentId, admitted.change, signal)
        } catch (reason) {
            if (isDefiniteSettingsRefusal(reason)) {
                if (requests.get(key) === admitted) requests.delete(key)
            } else admitted.uncertain = true
            throw reason
        }
        if (requests.get(key) === admitted) requests.delete(key)
    }
    function unconfirmedSettingsChange(agentId: string, field: Intent['field']): Intent | null {
        for (const entry of requests.values()) {
            if (entry.owner === agentId && entry.uncertain && entry.change.field === field) return entry.change
        }
        return null
    }
    return { changeCoworkerSettings, unconfirmedSettingsChange }
}
