import { readAgentPicks } from './AgentPickerCard'

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }))
jest.mock('@/data/useWorkspaceAgents', () => ({ useWorkspaceAgents: () => null }))
jest.mock('@/components/buddy/AgentBuddy', () => ({ AgentBuddy: () => null }))

describe('readAgentPicks', () => {
    it('reads the coworkers the Foreman points at, with the tab each one opens on', () => {
        expect(readAgentPicks('show_agents', { agents: [{ agentId: 'a1' }, { agentId: 'a2', tab: 'Files', conversationId: 's9' }] })).toEqual([
            { agentId: 'a1', tab: null, conversationId: null },
            { agentId: 'a2', tab: 'files', conversationId: 's9' },
        ])
    })

    it('opens the apps of the coworker whose connector it sets up', () => {
        expect(readAgentPicks('open_connector_setup', { agentId: 'a1', slug: 'gmail' })).toEqual([{ agentId: 'a1', tab: 'services', conversationId: null }])
    })

    it('skips what is half written while the call streams', () => {
        expect(readAgentPicks('show_agents', { agents: [{ agentId: 'a1' }, { tab: 'chat' }, null] })).toEqual([{ agentId: 'a1', tab: null, conversationId: null }])
        expect(readAgentPicks('show_agents', {})).toEqual([])
    })
})
