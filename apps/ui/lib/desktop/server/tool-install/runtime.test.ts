import { expect, it, vi } from 'vitest'
import { createDesktopToolInstallRuntime } from './runtime'
const state = vi.hoisted(() => ({ runtime: { protocolVersion: 1 as const, launchNonce: 'launch', buildId: 'fixture', workspaceId: 1 as const, dataRoot: '/fixture', app: { origin: 'http://127.0.0.1:3100', sessionToken: 's'.repeat(32) }, engine: { origin: 'http://127.0.0.1:3101', apiKey: 'secret' } }, agent: { id: 'public-agent', engineAgentId: 'engine-agent', enabled: true }, session: { id: 'public-chat', agentId: 'public-agent', engineSessionId: 'engine-chat' } }))
vi.mock('../database', () => ({ openDesktopDatabase: async () => ({}) }))
vi.mock('../runtime', () => ({ readDesktopRuntime: async () => state.runtime }))
vi.mock('../store', () => ({ findDesktopAgent: async () => state.agent, findDesktopSession: async () => state.session }))
vi.mock('../coworker-delete', () => ({ assertCoworkerNotDeleting: async () => {} }))
vi.mock('../setup/service', () => ({ assertDesktopSetupChatAllowed: async () => {} }))
vi.mock('./store', () => ({ desktopToolInstallStore: () => ({}) }))
const base = { agentId: 'public-agent', sessionId: 'public-chat', runId: 'run', toolCallId: 'call', proposalRevision: '1' }
it('maps public source IDs only through the owned database rows before guest authority', async () => {
 const seen: unknown[] = [], runtime = state.runtime
 vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { seen.push(JSON.parse(String(init.body))); return Response.json({ guest: { engineAgentId: 'engine-agent', launchNonce: 'launch', sessionGeneration: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64) } }) }))
 try {
  const binding = await createDesktopToolInstallRuntime(runtime)
  await expect(binding.ports.authority(base, new AbortController().signal, 'review')).resolves.toMatchObject({ engineAgentId: 'engine-agent' })
  expect(seen[0]).toMatchObject({ source: { engineAgentId: 'engine-agent', sessionId: 'engine-chat', runId: 'run', toolCallId: 'call' }, phase: 'review' })
  state.session = { ...state.session, agentId: 'sibling' }
  await expect(binding.ports.authority(base, new AbortController().signal, 'review')).rejects.toThrow('conversation changed')
  expect(seen).toHaveLength(1)
 } finally { state.session = { ...state.session, agentId: 'public-agent' }; vi.unstubAllGlobals() }
})
it('refuses a stale runtime before contacting its captured engine port', async () => {
 const binding = await createDesktopToolInstallRuntime(state.runtime), original = state.runtime
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
 try {
  state.runtime = { ...state.runtime, launchNonce: 'new-launch' }
  await expect(binding.ports.authority(base, new AbortController().signal, 'review')).rejects.toThrow('runtime changed')
  expect(fetcher).not.toHaveBeenCalled()
 } finally { state.runtime = original; vi.unstubAllGlobals() }
})
