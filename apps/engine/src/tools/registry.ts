import { desktopBrainSemanticTools } from '../desktop/brain-semantic/tool.js'
import { desktopMcpLoginTools } from '../desktop/mcp-login-tools/tools.js'
import { desktopPrivateRegexTools } from '../desktop/private-search/tools.js'
import { readDesktopScheduleTools } from '../desktop/schedule-tools/binding.js'
import { readDesktopToolInstall } from '../desktop/tool-install/binding.js'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { desktopForemanTools } from '../desktop/foreman/binding.js'
import { readDesktopDelegation } from '../desktop/delegation/binding.js'
import { desktopDelegationChildTools } from '../desktop/delegation/child-scope.js'
import { readDesktopTriggerTools } from '../desktop/trigger-tools/binding.js'
import type { ToolSet } from 'ai'
import { filesystemTools } from './builtin/filesystem.js'
import { sharedTools } from './builtin/shared.js'
import { shellTools } from './builtin/shell.js'
import { webTools } from './builtin/web.js'
import { memoryTools } from './builtin/memory.js'
import { dbTools } from './builtin/db.js'
import { sharedDbTools } from './builtin/shared-db.js'
import { brainTools, foremanBrainTools } from './builtin/brain.js'
import { skillTools } from './builtin/skills.js'
import { skillProposeTool } from './builtin/skill-propose.js'
import { selfTools } from './builtin/self.js'
import { scheduleTools } from './builtin/schedule.js'
import { triggerTools } from './builtin/trigger.js'
import { delegateTools } from './builtin/delegate.js'
import { callAgentTools } from './builtin/call-agent.js'
import { browserTools } from './builtin/browser.js'
import { visionTools } from './builtin/vision.js'
import { computerTools, offersComputer } from './builtin/computer.js'
import { notifyTools } from './builtin/notify.js'
import { hubTools } from './builtin/hub.js'
import { paidDataTools } from '../cloud/index.js'
import { cardTools, foremanCardTools } from './builtin/cards.js'
import { askUserTool, offersTakeover, requestApprovalTool, requestSecretTool, requestTakeoverTool, suggestServiceTool } from './builtin/hitl.js'
import { installTools } from './builtin/install.js'
import { foremanTools } from './builtin/foreman.js'
import { agentFilesTools } from './builtin/agent-files.js'
import { hasPendingSetup } from '../agents/setup.js'
import { pooledMcpTools } from './mcp-pool.js'
import { CLI_PROVIDERS } from '../agents/providers.js'
import { closeAgentDb } from '../db/agentDb.js'
import type { RunContext } from '../runtime/context.js'
import { desktopMemoryTools } from '../desktop/memory-tools.js'
import { desktopWorkspaceReadTools } from '../desktop/workspace-read.js'
import { desktopQuestionTools } from '../desktop/question-tool.js'
import { desktopApprovalTools } from '../desktop/approval-tool.js'
import { desktopTableCardTools } from '../desktop/card-table.js'
import { hasDesktopToolGrant, requireDesktopToolGrant } from '../desktop/tool-grants.js'
import { desktopCardFileTools } from '../desktop/card-file.js'
import { desktopSelfInstructionTools } from '../desktop/self-instruction.js'
import { desktopWebFetchTools } from '../desktop/web-fetch-tool.js'
import { desktopDbTools, desktopSharedDbTools } from '../desktop/data-tools.js'
import { desktopApp } from '../desktop/policy.js'
import { desktopSkillTools } from '../desktop/skill-tools.js'
import { desktopPrivateFileTools } from '../desktop/private-file-tools.js'
import { desktopSharedFileTools } from '../desktop/shared-file-tools.js'
import { desktopSharedMutationTools } from '../desktop/shared-file-mutations/tools.js'
import { desktopMcpTools } from '../desktop/mcp-tools.js'
import { desktopStdioTools } from '../desktop/mcp-stdio/client.js'
import { desktopServiceTools } from '../desktop/service-tools.js'
import { desktopSuggestServiceTools } from '../desktop/service-requests/suggest-service.js'
import { desktopSelfMcpTools } from '../desktop/self-mcp/index.js'
import { desktopSecretRequestTools } from '../desktop/secret-requests/request-secret.js'
import { desktopWebSearchTools } from '../desktop/web-search-tool.js'
import { desktopWebSearch } from '../desktop/web-search/client.js'
import { desktopSetupRunAllowed, desktopSetupTools } from '../desktop/setup/service.js'
import { desktopBrowserExportPublisher } from '../desktop/isolated-screen/export-client.js'
import { isolatedScreenTools } from '../desktop/isolated-screen/tools.js'
import { desktopBrainTools } from '../desktop/brain-tools.js'
import { readDesktopCoworkerCallRuntime } from '../desktop/coworker-calls/bind.js'
import { desktopCallAgentTools } from '../desktop/coworker-calls/tool.js'
import { desktopDownloadTools } from '../desktop/download-tools/tool.js'
import { bindDesktopDownloadPermission } from '../desktop/download-tools/binding.js'
import { desktopNotifyTools } from '../desktop/notify-tools/index.js'
import { desktopTableViewTools } from '../desktop/table-view-tools/index.js'
import { desktopVisionTools } from '../desktop/vision-tools/tools.js'
import { bindDesktopTeamReads, desktopTeamReadPorts, readDesktopTeamAdmit, readDesktopTeamReadGrantFromDisk, readDesktopTeamReads } from '../desktop/team-reads/index.js'
import { desktopTeamDirectory } from '../desktop/team-reads/directory.js'

let downloadPermissionBound = false
function ensureDesktopDownloadPermission() {
    if (downloadPermissionBound) return
    downloadPermissionBound = true
    bindDesktopDownloadPermission(async ctx => { await requireDesktopToolGrant(ctx, 'download') })
}

let teamReadsBound = false
function ensureDesktopTeamReads() {
    if (teamReadsBound) return
    teamReadsBound = true
    bindDesktopTeamReads({
        grant: readDesktopTeamReadGrantFromDisk,
        admit: readDesktopTeamAdmit,
        reads: desktopTeamReadPorts(),
        directory: desktopTeamDirectory(),
    })
}

export async function buildTools(ctx: RunContext): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
    if (desktopApp()) {
        if (ctx.agent.id === FOREMAN_AGENT_ID || ctx.agent.config.kind === 'foreman') return desktopForemanTools(ctx)
        const child = await desktopDelegationChildTools(ctx)
        if (child) return child
        const screen = isolatedScreenTools(ctx, { publishExports: desktopBrowserExportPublisher })
        ensureDesktopDownloadPermission()
        ensureDesktopTeamReads()
        const tools: ToolSet = { ...screen.tools, ...desktopWorkspaceReadTools(ctx), ...desktopPrivateFileTools(ctx), ...desktopSharedFileTools(ctx), ...desktopSharedMutationTools(ctx), ...desktopMemoryTools(ctx), ...desktopQuestionTools(ctx), ...desktopApprovalTools(ctx), ...desktopSuggestServiceTools(ctx), ...desktopCardFileTools(ctx), ...desktopTableCardTools(ctx, config => config.enabled && hasDesktopToolGrant(config, 'cardTable')), ...desktopTableViewTools(ctx, config => config.enabled && hasDesktopToolGrant(config, 'tableViewWrite')), ...desktopSelfInstructionTools(ctx), ...desktopWebFetchTools(ctx), ...desktopDownloadTools(ctx), ...desktopDbTools(ctx), ...desktopSharedDbTools(ctx), ...desktopSkillTools(ctx), ...desktopBrainTools(ctx), ...desktopBrainSemanticTools(ctx) }
        Object.assign(tools, readDesktopDelegation()?.tools(ctx) ?? {})
        Object.assign(tools, desktopSecretRequestTools(ctx))
        if (hasDesktopToolGrant(ctx.agent.config, 'workspaceSearch')) Object.assign(tools, desktopPrivateRegexTools(ctx))
        Object.assign(tools, desktopMcpLoginTools(ctx))
        if (!ctx.agent.config.ephemeral && hasDesktopToolGrant(ctx.agent.config, 'guestShell')) Object.assign(tools, readDesktopGuestShell()?.tools(ctx) ?? {})
        if (!ctx.agent.config.ephemeral && hasDesktopToolGrant(ctx.agent.config, 'scheduleManage')) Object.assign(tools, readDesktopScheduleTools()?.tools(ctx.agent.id, ctx) ?? {})
        if (!ctx.agent.config.ephemeral && hasDesktopToolGrant(ctx.agent.config, 'toolInstall')) Object.assign(tools, readDesktopToolInstall()?.tools(ctx) ?? {})
        Object.assign(tools, desktopSelfMcpTools(ctx))
        Object.assign(tools, desktopWebSearchTools(ctx, { search: desktopWebSearch }))
        const triggers = readDesktopTriggerTools()
        if (triggers && hasDesktopToolGrant(ctx.agent.config, 'trigger') && !ctx.agent.config.ephemeral) Object.assign(tools, triggers.tools(ctx.agent.id, ctx))
        const calls = readDesktopCoworkerCallRuntime()
        if (calls && hasDesktopToolGrant(ctx.agent.config, 'callAgent') && !ctx.agent.config.ephemeral) Object.assign(tools, desktopCallAgentTools(ctx, calls))
        const teamReads = readDesktopTeamReads()
        if (teamReads && !ctx.agent.config.ephemeral) Object.assign(tools, teamReads.tools(ctx))
        if (hasDesktopToolGrant(ctx.agent.config, 'vision')) Object.assign(tools, desktopVisionTools(ctx))
        if (hasDesktopToolGrant(ctx.agent.config, 'notify')) Object.assign(tools, desktopNotifyTools(ctx))
        if (ctx.agent.config.setup?.required && ctx.agent.install && desktopSetupRunAllowed(ctx.agent, ctx.sessionId)) Object.assign(tools, desktopSetupTools(ctx))
        const remote = await desktopMcpTools(ctx)
        if (Object.keys(remote.tools).some(name => Object.hasOwn(tools, name))) {
            await remote.close()
            throw new Error('An MCP tool conflicts with a built-in tool. Rename the MCP server.')
        }
        let local: Awaited<ReturnType<typeof desktopStdioTools>> | undefined
        let services: Awaited<ReturnType<typeof desktopServiceTools>> | undefined
        try {
            if (hasDesktopToolGrant(ctx.agent.config, 'localMcpStdio')) local = await desktopStdioTools(ctx, () => requireDesktopToolGrant(ctx, 'localMcpStdio'))
            const merged = { ...tools, ...remote.tools }
            if (Object.keys(local?.tools ?? {}).some(name => Object.hasOwn(merged, name))) throw new Error('A local MCP tool conflicts with another tool. Rename the MCP server.')
            const existing = { ...merged, ...local?.tools }
            if (hasDesktopToolGrant(ctx.agent.config, 'services')) services = await desktopServiceTools(ctx)
            if (Object.keys(services?.tools ?? {}).some(name => Object.hasOwn(existing, name))) throw new Error('An app tool conflicts with another tool.')
            return { tools: { ...existing, ...services?.tools }, close: async () => { try { await services?.close() } finally { try { await local?.close() } finally { try { await remote.close() } finally { screen.release() } } } } }
        } catch (error) { try { await services?.close() } finally { try { await local?.close() } finally { try { await remote.close() } finally { screen.release() } } }; throw error }
    }
    const cfg = ctx.agent.config.tools
    const tools: ToolSet = {}
    if (ctx.agent.config.kind === 'foreman') Object.assign(tools, foremanTools(ctx), agentFilesTools())
    if (cfg.filesystem) Object.assign(tools, filesystemTools(ctx))
    if (cfg.shared) Object.assign(tools, sharedTools(ctx))
    if (cfg.shell) Object.assign(tools, shellTools(ctx))
    if (cfg.web) Object.assign(tools, webTools(ctx))
    // A CLI searches with its own tool, on the subscription; see CLAUDE_RUN_TOOLS.
    if (CLI_PROVIDERS.has(ctx.provider)) delete tools.web_search
    if (cfg.memory) Object.assign(tools, memoryTools(ctx))
    if (cfg.db) Object.assign(tools, dbTools(ctx))
    if (cfg.sharedDb) Object.assign(tools, sharedDbTools(ctx))
    if (cfg.brain) Object.assign(tools, ctx.agent.config.kind === 'foreman' ? foremanBrainTools() : brainTools(ctx))
    if (cfg.skills) Object.assign(tools, skillTools(ctx))
    if (cfg.skills && ctx.agent.config.selfImprovement.enabled) Object.assign(tools, skillProposeTool(ctx))
    if (ctx.agent.config.selfImprovement.enabled) Object.assign(tools, selfTools(ctx))
    if (cfg.schedule) Object.assign(tools, scheduleTools(ctx))
    if (cfg.trigger) Object.assign(tools, triggerTools(ctx))
    if (cfg.delegate) Object.assign(tools, delegateTools(ctx))
    if (cfg.callAgent && ctx.callTargets?.length) Object.assign(tools, callAgentTools(ctx))
    if (cfg.browser) Object.assign(tools, browserTools(ctx))
    if (offersTakeover(ctx.agent.config)) Object.assign(tools, requestTakeoverTool(ctx))
    if (cfg.vision) Object.assign(tools, visionTools(ctx))
    const computer = offersComputer(ctx.agent.config) ? computerTools(ctx) : null
    if (computer) Object.assign(tools, computer.tools)
    if (cfg.notify) Object.assign(tools, notifyTools(ctx))
    if (cfg.hub) Object.assign(tools, hubTools(ctx))
    if (cfg.paidData) Object.assign(tools, paidDataTools(ctx))
    if (cfg.cards) Object.assign(tools, ctx.agent.config.kind === 'foreman' ? foremanCardTools(ctx) : cardTools(ctx))
    if (cfg.askUser) Object.assign(tools, askUserTool(ctx))
    if (cfg.requestApproval) Object.assign(tools, requestApprovalTool(ctx))
    if (cfg.suggestService) Object.assign(tools, suggestServiceTool(ctx))
    if (cfg.requestSecret) Object.assign(tools, requestSecretTool(ctx))
    // Only exists while there is an installation to close, so no other agent carries a tool it
    // could never legitimately call.
    if (hasPendingSetup(ctx.agent)) Object.assign(tools, installTools(ctx))

    // The connections are the pool's, kept across runs: the run's close leaves them open.
    if (!CLI_PROVIDERS.has(ctx.provider) && ctx.agent.config.mcpServers.length > 0) Object.assign(tools, await pooledMcpTools(ctx.agent))

    return {
        tools,
        // The shared database is one handle for the whole process, so it is deliberately left
        // open: closing it here would break a run another agent still has in flight.
        close: async () => {
            computer?.release()
            closeAgentDb(ctx.agent.id)
        },
    }
}
import { readDesktopGuestShell } from '../desktop/guest-shell/runtime.js'
