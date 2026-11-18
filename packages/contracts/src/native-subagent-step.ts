// These are the only child details that may leave the provider adapter. Prompts,
// native thread identifiers, and the worker's transcript stay out of chat and activity.
export type NativeSubagentOutcome = 'completed' | 'failed' | 'cancelled'

export function nativeSubagentOutcome(value: unknown): NativeSubagentOutcome | undefined {
    if (!value || typeof value !== 'object') return
    if ('type' in value && value.type === 'json' && 'value' in value) value = value.value
    if (!value || typeof value !== 'object' || !('status' in value)) return
    const status = value.status
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return status
}

export function nativeSubagentName(input: unknown): string {
    if (!input || typeof input !== 'object') return 'Sub-agent'
    const name = 'name' in input ? input.name : 'preview' in input ? input.preview : undefined
    return typeof name === 'string' && /^Claude helper(?: [1-9][0-9]{0,6})?$/.test(name) ? name : 'Sub-agent'
}
