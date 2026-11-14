export class ScheduleRequestError extends Error {}

export async function scheduleRequest(agentId: string, method: string, body?: unknown, query = '', signal?: AbortSignal) {
    const response = await fetch(`/api/desktop/coworkers/${encodeURIComponent(agentId)}/schedules${query}`, {
        method, cache: 'no-store', signal,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    })
    const result = await response.json()
    if (!response.ok) {
        const message = typeof result?.error === 'string' && result.error.trim().length > 0 && result.error.length <= 500
            ? result.error
            : 'Task request failed'
        throw new ScheduleRequestError(message)
    }
    return result
}
