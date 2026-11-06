import 'server-only'
import {
    externalMcpCreateResultSchema,
    externalMcpListResponseSchema,
    externalMcpListenerResultSchema,
    externalMcpListenerViewSchema,
    externalMcpRevokeResultSchema,
    externalMcpLiveCheckResultSchema,
    type ExternalMcpCreateRequest,
    type ExternalMcpEnableInput,
    type ExternalMcpRevokeInput,
    type ExternalMcpLiveCheckInput,
} from '@rerun/contracts'
import { z } from 'zod'
import { DesktopHttpError } from '../auth'
import type { DesktopRuntime } from '../runtime'

async function request<T>(runtime: DesktopRuntime, path: string, schema: z.ZodType<T>, body?: unknown, stop?: AbortSignal): Promise<T> {
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(stop ? [stop] : [])])
    let response: Response
    try {
        response = await fetch(`${runtime.engine.origin}/desktop/external-mcp${path}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: 'error',
            cache: 'no-store',
            signal,
        })
    } catch {
        throw new DesktopHttpError(502, 'Could not reach the external key service. Retry the same request.')
    }
    const text = await response.text()
    if (text.length > 1_000_000) throw new DesktopHttpError(502, 'External key response is too large.')
    let parsed: unknown
    try {
        parsed = text ? JSON.parse(text) : null
    } catch {
        throw new DesktopHttpError(502, 'External key response could not be confirmed. Retry the same request.')
    }
    const result = schema.safeParse(parsed)
    if (!result.success) throw new DesktopHttpError(response.ok ? 502 : response.status, 'External key request was not confirmed. Retry the same request.')
    if (!response.ok && result.data && typeof result.data === 'object' && 'ok' in result.data && result.data.ok === true) {
        throw new DesktopHttpError(response.status, 'External key request was not confirmed. Retry the same request.')
    }
    return result.data
}

export function listDesktopExternalMcpKeys(runtime: DesktopRuntime, workspaceId: number) {
    return request(runtime, `/keys?workspaceId=${workspaceId}`, externalMcpListResponseSchema)
}

export function createDesktopExternalMcpKey(runtime: DesktopRuntime, input: ExternalMcpCreateRequest) {
    return request(runtime, '/keys', externalMcpCreateResultSchema, input)
}

export function revokeDesktopExternalMcpKey(runtime: DesktopRuntime, input: ExternalMcpRevokeInput) {
    return request(runtime, '/keys/revoke', externalMcpRevokeResultSchema, input)
}

/** The one live listener. It is not selected by workspace; the view carries the bound workspace. */
export function readDesktopExternalMcpListener(runtime: DesktopRuntime) {
    return request(runtime, '/listener', externalMcpListenerViewSchema)
}

export function enableDesktopExternalMcpListener(runtime: DesktopRuntime, input: ExternalMcpEnableInput) {
    return request(runtime, '/listener/enable', externalMcpListenerResultSchema, input)
}

export function disableDesktopExternalMcpListener(runtime: DesktopRuntime, input: ExternalMcpEnableInput) {
    return request(runtime, '/listener/disable', externalMcpListenerResultSchema, input)
}

export function recheckDesktopExternalMcp(runtime: DesktopRuntime, input: ExternalMcpLiveCheckInput, signal?: AbortSignal) {
    const { keyId, workspaceId, keyRevision, installId, launchNonce, requestId, scopes } = input
    return request(runtime, '/recheck', externalMcpLiveCheckResultSchema, { keyId, workspaceId, keyRevision, installId, launchNonce, requestId, scopes }, signal)
}
