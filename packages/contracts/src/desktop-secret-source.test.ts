import { expect, test } from 'vitest'
import { findDesktopSecretRequest, parseDesktopSecretToolInput, type DesktopSecretRequestRow } from './desktop-secret-requests.js'
const input = { secrets: [{ key: 'EXAMPLE_API_KEY', label: 'Example key', help: null }], reason: null }
const call: DesktopSecretRequestRow = { id: 'message', role: 'assistant', contentJson: JSON.stringify([{ type: 'tool-call', toolName: 'mcp__rerun__request_secret', toolCallId: 'call', input }]), createdAt: '2026-11-05T12:00:00Z' }
const result: DesktopSecretRequestRow = { id: 'result', role: 'tool', contentJson: JSON.stringify([{ type: 'tool-result', toolCallId: 'call', output: { type: 'json', value: { status: 'delivered' } } }]) }
test('the exact acknowledged call creates the bounded masked form, including bridge prefixes and null optionals', () => {
    expect(findDesktopSecretRequest([call])).toBeNull()
    expect(findDesktopSecretRequest([call, result])).toMatchObject({ sourceMessageId: 'message', toolCallId: 'call', fields: [{ key: 'EXAMPLE_API_KEY', label: 'Example key' }], requestedAt: call.createdAt })
    expect(parseDesktopSecretToolInput(input)).toEqual({ fields: [{ key: 'EXAMPLE_API_KEY', label: 'Example key' }] })
})
test('foreign/error acknowledgements, newer requests and later user turns never activate an old form', () => {
    expect(findDesktopSecretRequest([call, { ...result, contentJson: result.contentJson.replace('"call"', '"foreign"') }])).toBeNull()
    expect(findDesktopSecretRequest([call, { ...result, contentJson: result.contentJson.replace('"json"', '"error-json"') }])).toBeNull()
    expect(findDesktopSecretRequest([call, result, { id: 'user', role: 'user', contentJson: 'Continue' }])).toBeNull()
    expect(findDesktopSecretRequest([call, result, { ...call, id: 'new', contentJson: call.contentJson.replace('request_secret', 'ask_user') }])).toBeNull()
})
test('malformed, secret-bearing, duplicate and runtime-reserved fields never become a form', () => {
    expect(parseDesktopSecretToolInput({ secrets: [{ key: 'PATH', label: 'Path' }] })).toBeNull()
    expect(parseDesktopSecretToolInput({ secrets: [input.secrets[0], input.secrets[0]] })).toBeNull()
    expect(parseDesktopSecretToolInput({ secrets: [{ ...input.secrets[0], value: 'must not appear' }] })).toBeNull()
    expect(parseDesktopSecretToolInput({ secrets: [{ ...input.secrets[0], docsUrl: 'http://insecure.example' }] })).toBeNull()
})
