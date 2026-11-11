import 'server-only'
import { oauthDeviceForm, oauthHttps, type OAuthDeviceForm } from '../mcp/oauth-network'
import { approvedDeviceMethodSchema, devicePollSchema, deviceStartSchema, parsePrivate, type ApprovedDeviceMethod } from './model'
import type { DeviceCustodyPorts } from './custody'

const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code'
const pollOutcomes = new Map([
    ['authorization_pending', 'pending'], ['slow_down', 'slow_down'],
    ['access_denied', 'denied'], ['expired_token', 'expired'],
])
const unavailable = () => new Error('Device authorization response is unavailable or unsupported.')

function reviewedMethod(value: ApprovedDeviceMethod) {
    const method = parsePrivate(approvedDeviceMethodSchema, value)
    if (method.kind !== 'device-code-rfc8628-v1' || !/^[\x21-\x7e]{1,256}$/.test(method.clientId)
        || method.scope !== undefined && !/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(method.scope)) throw unavailable()
    for (const url of [method.resource, method.issuer, method.verificationUri, method.deviceEndpoint, method.tokenEndpoint]) oauthHttps(url)
    return method
}

/** Only a reviewed public-client RFC 8628 method can use this transport. */
export function createMcpDeviceBroker(form: OAuthDeviceForm = oauthDeviceForm): NonNullable<DeviceCustodyPorts['broker']> {
    return {
        async start(value, signal) {
            const method = reviewedMethod(value)
            signal.throwIfAborted()
            const params = new URLSearchParams({ client_id: method.clientId, resource: method.resource })
            if (method.scope) params.set('scope', method.scope)
            const { status, body } = await form(method.deviceEndpoint, signal, params, false)
            signal.throwIfAborted()
            if (status !== 200 || body.error !== undefined || body.verification_uri !== method.verificationUri
                || typeof body.user_code !== 'string' || body.user_code === body.device_code) throw unavailable()
            return parsePrivate(deviceStartSchema, {
                deviceCode: body.device_code, userCode: body.user_code, verificationUri: body.verification_uri,
                expiresIn: body.expires_in, interval: body.interval === undefined ? 5 : body.interval,
            })
        },
        async poll(value, deviceCode, signal) {
            const method = reviewedMethod(value)
            if (!/^[\x21-\x7e]{1,8192}$/.test(deviceCode)) throw unavailable()
            signal.throwIfAborted()
            const params = new URLSearchParams({ grant_type: deviceGrant, device_code: deviceCode, client_id: method.clientId, resource: method.resource })
            const { status, body } = await form(method.tokenEndpoint, signal, params, true)
            signal.throwIfAborted()
            if (status === 400 && typeof body.error === 'string' && body.access_token === undefined && body.refresh_token === undefined) {
                const state = pollOutcomes.get(body.error)
                if (state) return parsePrivate(devicePollSchema, { state })
            }
            if (status !== 200 || body.error !== undefined || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
                || body.iss !== undefined && body.iss !== method.issuer || body.resource !== undefined && body.resource !== method.resource
                || body.scope !== undefined && body.scope !== method.scope) throw unavailable()
            return parsePrivate(devicePollSchema, { state: 'authorized', token: {
                accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in, tokenType: 'Bearer', scope: body.scope,
            } })
        },
    }
}
