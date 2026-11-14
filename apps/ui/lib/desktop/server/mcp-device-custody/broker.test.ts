import { expect, it, vi } from 'vitest'
import type { OAuthDeviceForm } from '../mcp/oauth-network'
import { createMcpDeviceBroker } from './broker'
import type { ApprovedDeviceMethod } from './model'

const method: ApprovedDeviceMethod = {
    kind: 'device-code-rfc8628-v1', resource: 'https://resource.example/mcp', issuer: 'https://issuer.example/',
    deviceEndpoint: 'https://issuer.example/device', tokenEndpoint: 'https://issuer.example/token',
    verificationUri: 'https://issuer.example/activate', clientId: 'approved-client', scope: 'notes.read',
}
const signal = new AbortController().signal
const approval = {
    device_code: 'PRIVATE-DEVICE-CODE', user_code: 'USER-QA',
    verification_uri: method.verificationUri, verification_uri_complete: method.verificationUri + '?user_code=USER-QA',
    expires_in: 300,
}

it('uses only the approved public client, resource and scope, and discards the code-bearing URL', async () => {
    const form = vi.fn<OAuthDeviceForm>().mockResolvedValue({ status: 200, body: approval })
    const result = await createMcpDeviceBroker(form).start(method, signal)
    expect(form).toHaveBeenCalledExactlyOnceWith(method.deviceEndpoint, signal, new URLSearchParams({
        client_id: method.clientId, resource: method.resource, scope: 'notes.read',
    }), false)
    expect(result).toEqual({ deviceCode: 'PRIVATE-DEVICE-CODE', userCode: 'USER-QA', verificationUri: method.verificationUri, expiresIn: 300, interval: 5 })
})

it.each([
    { verification_uri: 'https://foreign.example/activate' },
    { verification_uri: method.verificationUri + '?code=PRIVATE-DEVICE-CODE' },
    { user_code: undefined }, { user_code: 'PRIVATE-DEVICE-CODE' }, { expires_in: 1801 }, { interval: 0 },
])('refuses an unsafe or incomplete authorization response: %j', async change => {
    const form = vi.fn<OAuthDeviceForm>().mockResolvedValue({ status: 200, body: { ...approval, ...change } })
    await expect(createMcpDeviceBroker(form).start(method, signal)).rejects.toThrow()
})

it.each([
    ['authorization_pending', 'pending'], ['slow_down', 'slow_down'],
    ['access_denied', 'denied'], ['expired_token', 'expired'],
])('maps only the defined %s poll error without returning diagnostics', async (error, state) => {
    const form = vi.fn<OAuthDeviceForm>().mockResolvedValue({ status: 400, body: { error, error_description: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' } })
    expect(await createMcpDeviceBroker(form).poll(method, 'PRIVATE-DEVICE-CODE', signal)).toEqual({ state })
    expect(form).toHaveBeenCalledExactlyOnceWith(method.tokenEndpoint, signal, new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'PRIVATE-DEVICE-CODE', client_id: method.clientId, resource: method.resource,
    }), true)
})

it.each([
    { status: 400, body: { error: 'server_error' } },
    { status: 200, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'slow_down', access_token: 'SYNTHETIC_TOKEN' } },
    { status: 302, body: { error: 'authorization_pending' } },
    { status: 200, body: { token_type: 'Bearer', access_token: 'SYNTHETIC_TOKEN', expires_in: 900, resource: 'https://foreign.example/mcp' } },
    { status: 200, body: { token_type: 'Bearer', access_token: 'SYNTHETIC_TOKEN', expires_in: 900, scope: 'notes.write' } },
])('refuses ambiguous, redirected and mismatched token responses: %j', async response => {
    const form = vi.fn<OAuthDeviceForm>().mockResolvedValue(response)
    await expect(createMcpDeviceBroker(form).poll(method, 'PRIVATE-DEVICE-CODE', signal)).rejects.toThrow()
    expect(form).toHaveBeenCalledTimes(1)
})

it('refuses changed authority and aborts before starting or returning any response', async () => {
    const controller = new AbortController()
    const form = vi.fn<OAuthDeviceForm>().mockImplementation(async () => { controller.abort(); return { status: 200, body: approval } })
    const broker = createMcpDeviceBroker(form)
    await expect(broker.start({ ...method, deviceEndpoint: 'https://foreign.example/device' }, signal)).rejects.toThrow()
    await expect(broker.start({ ...method, kind: 'device-code-link-v1' }, signal)).rejects.toThrow()
    expect(form).not.toHaveBeenCalled()
    await expect(broker.start(method, controller.signal)).rejects.toThrow()
    await expect(broker.poll(method, 'PRIVATE-DEVICE-CODE', controller.signal)).rejects.toThrow()
    expect(form).toHaveBeenCalledTimes(1)
})
