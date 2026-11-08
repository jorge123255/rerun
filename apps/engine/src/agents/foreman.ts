import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { FOREMAN_AGENT_ID, TOOL_KEYS, type AgentConfig, type ToolKey } from '@rerun/contracts'
import { configPath, soulPath, workspaceDir } from '../config/paths.js'
import { writeAgentConfig } from './config-write.js'
import { agentConfigSchema } from './types.js'
import { unloadAgent } from './registry.js'

// Only what the hub does not send: the brief of each chat request replaces it. A run that reaches
// the foreman without a brief (an old hub, a direct call) still has something coherent to say.
const FOREMAN_SOUL = `# Foreman

You are the Foreman of this Rerun workspace: the assistant that sets up and runs the user's team of coworkers from outside the board. Answer in the user's language, lead with the result, and keep it short.
`

// The orchestrator works on the box like any agent (files, shell, web, sub-agents, the company
// brain, which it keeps rather than proposes to) and on the account through the tools the hub hands
// it. What stays off is everything of its own it would keep between conversations (memory, skills,
// schedules, triggers, connectors). Of the cards it keeps only the file tiles: the user cannot reach
// the server, so a file it made is seen there or not at all.
const FOREMAN_TOOL_KEYS = new Set<ToolKey>(['filesystem', 'shared', 'shell', 'web', 'sharedDb', 'brain', 'delegate', 'callAgent', 'browser', 'vision', 'askUser', 'requestApproval', 'cards'])

function foremanConfig(choice: ForemanChoice): AgentConfig {
    const tools = Object.fromEntries(TOOL_KEYS.map(key => [key, FOREMAN_TOOL_KEYS.has(key)]))
    return agentConfigSchema.parse({
        ...choice.model,
        name: FOREMAN_AGENT_ID,
        kind: 'foreman',
        displayName: 'Foreman',
        tools: { ...tools, desktopToolGrants: choice.grants },
        selfImprovement: { enabled: false, allowToolInstall: false, allowSoulEdit: false, autoMemory: false },
        setup: { required: false },
    })
}

type ModelPin = Pick<AgentConfig, 'connectionId' | 'provider' | 'model'>
type ForemanChoice = { model: ModelPin; grants: { foremanAgentFilesRead: boolean; foremanAgentFilesWrite: boolean; delegate?: boolean } }

// Preserve only the user's model and explicit desktop permissions; program-owned
// identity, instructions and every other capability are still rebuilt from code.
async function currentChoice(): Promise<ForemanChoice> {
    try {
        const { connectionId, provider, model, tools } = agentConfigSchema.parse(JSON.parse(await readFile(configPath(FOREMAN_AGENT_ID), 'utf8')))
        return { model: { connectionId, provider, model }, grants: {
            foremanAgentFilesRead: tools.desktopToolGrants?.foremanAgentFilesRead === true,
            foremanAgentFilesWrite: tools.desktopToolGrants?.foremanAgentFilesWrite === true,
            ...(tools.desktopToolGrants?.delegate === true && { delegate: true }),
        } }
    } catch {
        return { model: { connectionId: null, provider: null, model: null }, grants: { foremanAgentFilesRead: false, foremanAgentFilesWrite: false } }
    }
}

// Rewritten from code on every boot rather than created once, so each engine update ships the
// foreman it was built with. Deliberately never inserted in the agent index.
export async function ensureForeman(): Promise<void> {
    await mkdir(workspaceDir(FOREMAN_AGENT_ID), { recursive: true })
    await writeAgentConfig(FOREMAN_AGENT_ID, foremanConfig(await currentChoice()))
    await writeFile(soulPath(FOREMAN_AGENT_ID), FOREMAN_SOUL, 'utf8')
    unloadAgent(FOREMAN_AGENT_ID)
}
