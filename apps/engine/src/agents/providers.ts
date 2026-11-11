import { desktopOpencodeLanguageModel } from '../desktop/opencode/model.js'
import { desktopOpencodeCredential } from '../desktop/opencode/registry.js'
import { isCredentialRejected } from '../connections/credential-rejections.js'
import { customInferenceModel } from '../desktop/custom-providers/model.js'
import { createDesktopSubscriptionModel } from '../desktop/subscription-acp/model.js'
import { findDesktopSubscriptionConnection } from '../desktop/subscription-acp/connections.js'
import { desktopDelegationCodexCwd } from '../desktop/delegation/child-scope.js'
import { createProviderRegistry, wrapLanguageModel, type LanguageModel, type ToolSet } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createClaudeCode, createCustomMcpServer, type McpServerConfig, type MinimalCallToolResult } from 'ai-sdk-provider-claude-code'
import {
    createCodexAppServer,
    createCodexExec,
    createSdkMcpServer,
    tool as codexTool,
    type CodexAppServerSettings,
    type CodexExecSettings,
    type LocalTool,
} from 'ai-sdk-provider-codex-cli'
import type { ZodObject, ZodRawShape, ZodType } from 'zod'
import { desktopCodexGrantsOf, desktopRerunGrantsOf, desktopRerunToolCatalog, isDesktopSubscriptionProvider, parseDesktopSubscriptionConnectionId, type ContextOccupancy, type McpServer, type Provider } from '@rerun/contracts'
import { env } from '../config/env.js'
import { codexHomeDir } from '../config/paths.js'
import { allowedModel } from '../connections/plan.js'
import { RERUN_CONNECTION_ID } from '@rerun/contracts'
import { newId } from '../lib/ids.js'
import { resolveTransport } from '../tools/mcp.js'
import { relayMcpServer, type RunMcpServer } from '../tools/mcp-relay.js'
import { claudeContextCapture, type ClaudeContextCapture } from './claude-context.js'
import { claudeScreenshotMiddleware } from './claude-stream.js'
import { codexMcpCompatibilityMiddleware } from './codex-stream.js'
import { googleToolSchemaMiddleware } from './google-tool-schema.js'
import { createQuickRepliesCapture, type QuickRepliesCapture } from './quick-replies-stream.js'
import { createFakeToolCallGuard } from './fake-tool-call-stream.js'
import { createCardTagGuard } from './card-tag-stream.js'
import { cardTagStopHook } from './claude-card-nudge.js'
import { openrouterReasoningMiddleware, reasoningFetch } from './openrouter-reasoning.js'
import { cacheBreakpointsFetch } from './openrouter-cache.js'
import { openrouterStreamRetryMiddleware } from './openrouter-stream-retry.js'
import { agentProcessEnv } from './process-env.js'
import { BRIDGE_SERVER_NAME, CLI_PROVIDERS, type LoadedAgent } from './types.js'
import { hubCallerHeaders } from '../runtime/hub.js'
import { desktopClaudeRuntime } from '../desktop/claude-plan/runtime.js'
import { desktopCodexRuntime, signedInFlag } from '../desktop/codex-runtime.js'
import type { DesktopNativeWorker } from '../desktop/native-worker.js'
import { createDesktopCodexImageMiddleware, type DesktopCodexImageRun } from '../desktop/codex-images.js'
import { assertDesktopProvider, desktopApp } from '../desktop/policy.js'
import { isDesktopMcpLoginTool } from '../desktop/mcp-login-tools/admission.js'
import { isDesktopMcpTool } from '../desktop/mcp-tools.js'
import { isDesktopStdioTool } from '../desktop/mcp-stdio/client.js'
import { isDesktopServiceTool } from '../desktop/service-tools.js'
import { isDesktopSetupTool } from '../desktop/setup/service.js'
import { isDesktopForemanTool } from '../desktop/foreman/tool-identity.js'
import type { StoredScreenshot } from '../runtime/screenshots.js'

export { CLI_PROVIDERS }

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

// Fail fast rather than let an older CLI misbehave: the app-server JSON-RPC protocol this provider
// speaks landed in 0.144.
const CODEX_MIN_VERSION = '0.144.0'

// The bridged server carries Rerun's own tools, so a `tools/call` is a shell command or a whole
// agent run, not an RPC. Both CLIs default to a 300s tool timeout, which abandons work the engine
// finishes fine and leaves the caller with no way to recover the result.
const BRIDGE_TOOL_TIMEOUT_SEC = 3600

// The CLI is a transport for the subscription and nothing more: no built-in tool but WebSearch
// (Rerun's reach it bridged over MCP), no settings file, no prompt of its own. What it still does
// on its own initiative is switched off here so a run holds only what Rerun put in it. Every name exists in
// the CLI the Agent SDK ships (2.1.263); the provider forwards any `CLAUDE_*` through its allowlist
// and merges these over it, so the unprefixed one passes too.
export const CLAUDE_HARNESS_ENV = {
    // Rerun compacts the session before the run. A second compaction inside the CLI would rewrite
    // a history Rerun keeps sending in full, and the two would never agree on what was said.
    DISABLE_AUTO_COMPACT: '1',
    // Update checks, telemetry, surveys.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
    // The CLI process exits with the turn, so nothing started in the background would outlive it.
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
} as const

// Codex's native sub-agents run inside the app-server, which is closed with the run: a child
// spawned without a matching wait is killed mid-work. `delegate_tasks` is the one way to delegate.
export const CODEX_DISABLED_FEATURES = ['multi_agent', 'multi_agent_v2'] as const

// Codex ships a skill system of its own, discovered under `$CODEX_HOME/skills` and fronted by a
// `.system/skill-creator`. An agent asked for a skill reaches for it instead of `skill_create`, and
// what it writes lands outside the Rerun store: invisible in the UI, absent from the agent archive,
// and sitting in a home that belongs to the connection rather than to the agent. There is no
// `features.skills` flag, so the `[skills]` table of config.toml is what closes it.
export const CODEX_SKILL_OVERRIDES = { 'skills.bundled.enabled': false, 'skills.include_instructions': false } as const

// The package declares these but does not export them.
type CodexMcpServerConfig = NonNullable<CodexAppServerSettings['mcpServers']>[string]
type CodexConfigOverrides = NonNullable<CodexAppServerSettings['configOverrides']>

// The Codex counterpart of CLAUDE_HARNESS_ENV, as config overrides. An unknown key is swallowed
// without a word, so every line here was read back from a run against 0.154 rather than trusted.
// `features.view_image` and `features.image_generation` are left on deliberately: vision and image
// generation stay. Two natives outlive the list: `apply_patch`, which has no switch at all, and
// `update_plan`, whose switch below 0.154 ignores. Neither reaches anything a Rerun tool does not.
export const CODEX_HARNESS_OVERRIDES: CodexConfigOverrides = {
    // An AGENTS.md in the workspace would become a second prompt.
    project_doc_max_bytes: 0,
    // The blocks Codex prepends to its instructions on its own.
    include_environment_context: false,
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    // A run reopens it in `codexAppServerProvider`, where the subscription pays for the search.
    web_search: 'disabled',
    'history.persistence': 'none',
    check_for_update_on_startup: false,
    'tools.update_plan.enabled': false,
    'tools.experimental_request_user_input.enabled': false,
    'features.apps': false,
    'features.memories': false,
    'features.goals': false,
    'features.tool_suggest': false,
    'features.hooks': false,
    'features.code_mode': false,
    // Running a command is shell_exec, the Rerun tool. These two close Codex's own shell whole:
    // with them the model answers that it has no way to run a command.
    'features.shell_tool': false,
    'features.unified_exec': false,
    // A binary too old to know those two keeps its shell, and that shell drops any inherited
    // variable named like a key or a token, which shell_exec passes on. These put the paths the
    // prompt names and the agent's .env back in it.
    'shell_environment_policy.inherit': 'all',
    'shell_environment_policy.ignore_default_excludes': true,
    ...Object.fromEntries(CODEX_DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
    ...CODEX_SKILL_OVERRIDES,
}

function openaiChat(options: Parameters<typeof createOpenAI>[0]) {
    const p = createOpenAI(options)
    return Object.assign(p, { languageModel: (id: string) => p.chat(id) })
}

function isZodSchema(schema: unknown): boolean {
    return !!schema && typeof schema === 'object' && ('_def' in schema || '~standard' in schema)
}

function bridgeableTools(tools: ToolSet): ToolSet {
    const out: ToolSet = Object.create(null)
    for (const [name, t] of Object.entries(tools)) {
        if (typeof t.execute === 'function' && isZodSchema(t.inputSchema)) out[name] = t
    }
    return out
}

function nativeMcpEntry(server: McpServer): McpServerConfig | null {
    const kind = resolveTransport(server)
    if (kind === 'stdio') return server.command ? { type: 'stdio', command: server.command, args: server.args, env: server.env } : null
    if (!server.url) return null
    if (kind === 'http') return { type: 'http', url: server.url, headers: server.headers }
    return { type: 'sse', url: server.url, headers: server.headers }
}

export type ScreenshotLookup = (id: string) => StoredScreenshot | undefined

type BridgedTool = ToolSet[string]
type BridgeCall = { requestId?: unknown; signal?: AbortSignal }

const bridgeError = (message: string): MinimalCallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] })

// What the model reads is the text the tool returned, as with any bridged tool. A result that names
// a screenshot of the run also carries the picture, which only this side of the bridge can attach.
export function claudeBridgeHandler(bridged: BridgedTool, screenshots?: ScreenshotLookup) {
    return async (args: Record<string, unknown>, extra: unknown): Promise<MinimalCallToolResult> => {
        const call = (extra ?? {}) as BridgeCall
        try {
            const result: unknown = await bridged.execute!(args, { toolCallId: call.requestId !== undefined ? String(call.requestId) : newId(), abortSignal: call.signal, messages: [] })
            const text = typeof result === 'string' ? result : (JSON.stringify(result) ?? 'undefined')
            const id = (result as { screenshotId?: unknown } | null)?.screenshotId
            const screenshot = typeof id === 'string' ? screenshots?.(id) : undefined
            return { content: [{ type: 'text', text }, ...(screenshot ? [{ type: 'image' as const, data: screenshot.image.toString('base64'), mimeType: screenshot.mediaType }] : [])] }
        } catch (error) {
            return bridgeError(error instanceof Error ? error.message : String(error))
        }
    }
}

export function claudeMcpConfig(tools?: ToolSet, mcpServers: RunMcpServer[] = [], screenshots?: ScreenshotLookup): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
    const bridged = tools ? bridgeableTools(tools) : {}
    const names = Object.keys(bridged)
    const servers: Record<string, McpServerConfig> = {}
    const allowedTools: string[] = []
    if (names.length) {
        servers[BRIDGE_SERVER_NAME] = createCustomMcpServer({
            name: BRIDGE_SERVER_NAME,
            tools: Object.fromEntries(names.map(name => [name, { description: bridged[name]!.description ?? '', inputSchema: bridged[name]!.inputSchema as ZodObject<ZodRawShape>, handler: claudeBridgeHandler(bridged[name]!, screenshots) }])),
        })
        allowedTools.push(...names.map(n => `mcp__${BRIDGE_SERVER_NAME}__${n}`))
    }
    for (const server of mcpServers) {
        const entry = server.relay ? relayMcpServer(server.relay, BRIDGE_TOOL_TIMEOUT_SEC * 1000) : nativeMcpEntry(server)
        if (!entry || server.name === BRIDGE_SERVER_NAME) continue
        servers[server.name] = entry
        allowedTools.push(`mcp__${server.name}`)
    }
    return { mcpServers: servers, allowedTools }
}

// Codex has no SSE transport, so an SSE server is dropped rather than mangled into an http entry.
function codexNativeMcpEntry(server: McpServer): CodexMcpServerConfig | null {
    const kind = resolveTransport(server)
    if (kind === 'stdio') return server.command ? { transport: 'stdio', command: server.command, args: server.args, env: server.env } : null
    if (kind === 'http' && server.url) return { transport: 'http', url: server.url, httpHeaders: server.headers }
    return null
}

// The patched SDK forwards Codex's transport call ID separately from model-authored input.
// A tool that has to stop with its run still reads `RunContext.abortSignal`.
function codexBridgedTools(tools: ToolSet, screenshots?: ScreenshotLookup): LocalTool[] {
    return Object.entries(bridgeableTools(tools)).map(([name, t]) =>
        codexTool({
            name,
            description: t.description ?? name,
            parameters: t.inputSchema as ZodType,
            execute: async (input, context?: { toolCallId?: string }) => {
                const transportToolCallId = context?.toolCallId
                const validCallId = typeof transportToolCallId === 'string' && transportToolCallId.length > 0 && transportToolCallId.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(transportToolCallId)
                if (desktopApp() && !validCallId) throw new Error('The Codex tool call identity is unavailable. Try the request again.')
                const result = await t.execute!(input, { toolCallId: validCallId ? transportToolCallId : newId(), messages: [] })
                if (!desktopApp() || !['computer', 'computer_open_app'].includes(name)) return result
                const metadata = result as { status?: string; screenshotId?: string; screen?: number[] } | null
                if (metadata?.status !== 'done') return result
                const shot = typeof metadata.screenshotId === 'string' ? screenshots?.(metadata.screenshotId) : undefined
                if (!shot || shot.mediaType !== 'image/jpeg' || !Buffer.isBuffer(shot.image) || shot.image.length < 1 || shot.image.length > 8 * 1024 * 1024 || !Array.isArray(metadata.screen) || metadata.screen.length !== 2 || !metadata.screen.every(n => Number.isInteger(n) && n > 0 && n <= 8192)) throw new Error('The screenshot could not be delivered. Request a fresh screenshot.')
                const wrapped = { [Symbol.for('rerun.desktop.codexMcpResult')]: {
                    // Codex prioritizes structuredContent over rich content. Keep metadata
                    // in the text block so the accompanying image reaches the model.
                    content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data: shot.image.toString('base64'), mimeType: shot.mediaType }],
                } }
                Object.defineProperty(wrapped, 'toJSON', { value: () => { throw new Error('Screenshot delivery is unavailable.') } })
                return wrapped
            },
        }),
    )
}

export function codexMcpConfig(tools?: ToolSet, mcpServers: McpServer[] = [], screenshots?: ScreenshotLookup): Record<string, CodexMcpServerConfig> {
    const servers: Record<string, CodexMcpServerConfig> = {}
    const bridged = tools ? codexBridgedTools(tools, screenshots) : []
    if (bridged.length) servers[BRIDGE_SERVER_NAME] = createSdkMcpServer({ name: BRIDGE_SERVER_NAME, tools: bridged })
    for (const server of mcpServers) {
        const entry = codexNativeMcpEntry(server)
        if (!entry || server.name === BRIDGE_SERVER_NAME) continue
        servers[server.name] = entry
    }
    return servers
}

// What a CLI provider takes from the run beyond its tools. `system` is the run's prompt, which the
// CLI takes through its settings rather than through the AI SDK message (see `applyCaching`): a
// one-shot call (compaction, curator, vision) has none here and keeps passing its own to
// generateText, where the provider folds it into the user turn. `claudeTools` reopens named Claude
// built-ins for that call alone; a run has only CLAUDE_RUN_TOOLS.
export type CliModelOptions = { system?: string; claudeTools?: readonly string[]; screenshots?: ScreenshotLookup; nativeWorker?: DesktopNativeWorker; desktopVision?: boolean }

// The subscription pays for the CLI's own web search, where Rerun's web_search would bill Brave to
// Rerun. Its WebFetch stays closed: it hands back a summary of the page, web_fetch the page itself.
export const CLAUDE_RUN_TOOLS = ['WebSearch'] as const

// A token handed over by environment variable is read by the CLI as inference-only whatever it was
// issued with, and the plan limits are only read with the profile scope. Only the sign-in flow asks
// for that scope, and it is also the only one that leaves a refresh token: a `claude setup-token`
// value pasted by hand has neither, and claiming the scope for it would promise a read that fails.
const CLAUDE_SIGN_IN_SCOPES = 'user:profile user:inference'

export function claudeAuthEnv(connection: Record<string, string>): { CLAUDE_CODE_OAUTH_TOKEN: string; CLAUDE_CODE_OAUTH_SCOPES: string | undefined } {
    return {
        CLAUDE_CODE_OAUTH_TOKEN: connection.CLAUDE_CODE_OAUTH_TOKEN ?? '',
        CLAUDE_CODE_OAUTH_SCOPES: connection.CLAUDE_CODE_OAUTH_REFRESH_TOKEN ? CLAUDE_SIGN_IN_SCOPES : undefined,
    }
}

type ClaudeHooks = NonNullable<ClaudeContextCapture['settings']['hooks']>

// Added beside the context capture's Stop hook, never in its place: a hook list that replaced it
// silently lost the context window gauge once before.
export function withCardTagNudge(hooks: ClaudeHooks | undefined): ClaudeHooks {
    const stop = hooks?.Stop ?? []
    return { ...hooks, Stop: [...stop, { hooks: [cardTagStopHook] }] }
}

function claudeProvider(agent: LoadedAgent, tools?: ToolSet, mcpServers: RunMcpServer[] = [], capture?: ClaudeContextCapture, options: CliModelOptions = {}, desktopRuntime?: ReturnType<typeof desktopClaudeRuntime>) {
    const desktop = desktopApp()
    if (desktop && !desktopRuntime) throw new Error('The isolated Claude runtime is unavailable.')
    const grants = desktopRerunGrantsOf(agent.config.tools)
    const allowed = new Set(desktopRerunToolCatalog.filter(entry => entry.available && grants[entry.id as keyof typeof grants]).flatMap(entry => entry.tools))
    const admitted = desktop ? Object.fromEntries(Object.entries(bridgeableTools(tools ?? {})).filter(([name, tool]) => allowed.has(name) || isDesktopForemanTool(tool, name, agent.id, agent.config.kind) || name === 'install_complete' && isDesktopSetupTool(tool, agent.id) || grants.mcp && isDesktopMcpTool(tool) || grants.mcp && isDesktopMcpLoginTool(tool, name, agent.id) || grants.localMcpStdio && isDesktopStdioTool(tool) || grants.services && isDesktopServiceTool(tool))) : tools
    const { mcpServers: servers, allowedTools } = claudeMcpConfig(admitted, desktop ? [] : mcpServers, options.screenshots)
    const { cwd, env: agentEnv } = agentProcessEnv(agent)
    return createClaudeCode({
        defaultSettings: {
            persistSession: false,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            tools: [...(options.claudeTools ?? [])],
            strictMcpConfig: true,
            enableFileCheckpointing: false,
            cwd,
            // Without this the CLI emits no thinking block at all, so the chat never shows what the
            // agent is working through. `adaptive` leaves the model to decide when it is worth it.
            thinking: { type: 'adaptive', display: 'summarized' },
            env: {
                ...agentEnv,
                ...CLAUDE_HARNESS_ENV,
                ...claudeAuthEnv(connectionEnv(agent)),
                ANTHROPIC_API_KEY: undefined,
                MCP_TOOL_TIMEOUT: String(BRIDGE_TOOL_TIMEOUT_SEC * 1000),
            },
            ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
            ...(allowedTools.length ? { mcpServers: servers, allowedTools } : {}),
            ...(capture ? { ...capture.settings, hooks: withCardTagNudge(capture.settings.hooks) } : {}),
            ...(desktopRuntime ? { ...desktopRuntime.settings, canUseTool: async (name, input) => allowedTools.includes(name) ? { behavior: 'allow' as const, updatedInput: input } : { behavior: 'deny' as const, message: 'This tool is not enabled for this coworker.' } } : {}),
        },
    })
}

// The credentials an agent runs on live on its box connection, not on the agent. An agent with no
// connection resolves to an empty set, which every provider reads as "no key" and fails on rather
// than silently borrowing an ambient one.
function connectionEnv(agent: LoadedAgent): Record<string, string> {
    return agent.resolved.connection?.env ?? {}
}

// Codex reads its credentials from `$CODEX_HOME/auth.json`, which codex-auth.ts writes before the
// run — there is no token setting to pass. `env` is merged over process.env by the provider. The
// home is the connection's, so agents sharing a subscription share one auth.json.
function codexShared(agent: LoadedAgent): CodexExecSettings & CodexAppServerSettings {
    if (desktopApp()) {
        const cwd = desktopDelegationCodexCwd(agent)
        return { ...desktopCodexRuntime(), ...(cwd ? { cwd } : {}) }
    }
    const { RERUN_CODEX_PATH } = env()
    const { cwd, env: agentEnv } = agentProcessEnv(agent)
    return {
        cwd,
        env: { ...agentEnv, CODEX_HOME: codexHomeDir(agent.resolved.connection?.id ?? RERUN_CONNECTION_ID) },
        ...(RERUN_CODEX_PATH ? { codexPath: RERUN_CODEX_PATH } : {}),
    }
}

export const CODEX_ONE_SHOT_INSTRUCTIONS = 'Do what the user message asks and answer with the result alone.'

// One-shot calls (compaction, curator, vision, memory reconcile): no tools and no streaming needed,
// so the cheaper exec transport avoids a persistent process nobody would be left to close.
function codexExecProvider(agent: LoadedAgent) {
    return createCodexExec({
        defaultSettings: {
            ...codexShared(agent),
            approvalMode: 'never',
            sandboxMode: desktopApp() ? 'read-only' : 'danger-full-access',
            skipGitRepoCheck: true,
            // Codex's own prompt is a coding agent's, several thousand tokens on every call that no
            // cache ever holds. Each caller brings its own instructions in the user turn. `instructions`
            // was read back against 0.160; `base_instructions` is swallowed there.
            configOverrides: { ...(desktopApp() ? {} : CODEX_HARNESS_OVERRIDES), instructions: CODEX_ONE_SHOT_INSTRUCTIONS },
        },
    })
}

// The chat/run transport. Only the app-server emits real text deltas — exec returns the whole turn
// as a single chunk, which would leave the chat blank for the length of an agentic loop.
function codexAppServerProvider(agent: LoadedAgent, tools?: ToolSet, mcpServers: McpServer[] = [], options: CliModelOptions = {}) {
    const desktop = desktopApp()
    const shared = codexShared(agent)
    const grants = desktopRerunGrantsOf(agent.config.tools)
    const allowed = new Set(desktopRerunToolCatalog.filter(entry => entry.available && grants[entry.id as keyof typeof grants]).flatMap(entry => entry.tools))
    const localTools = desktop ? Object.fromEntries(Object.entries(bridgeableTools(tools ?? {})).filter(([name, tool]) => allowed.has(name) || isDesktopForemanTool(tool, name, agent.id, agent.config.kind) || name === 'install_complete' && isDesktopSetupTool(tool, agent.id) || grants.mcp && isDesktopMcpTool(tool) || grants.mcp && isDesktopMcpLoginTool(tool, name, agent.id) || grants.localMcpStdio && isDesktopStdioTool(tool) || grants.services && isDesktopServiceTool(tool))) : {}
    const names = Object.keys(localTools)
    const native = desktopCodexGrantsOf(agent.config.tools)
    const worker = options.nativeWorker
    if (desktop && (native.shell || native.workspaceWrite) && !worker) throw new Error('The isolated Codex command worker is unavailable.')
    const directNamespaces = [...(names.length ? [`mcp__${BRIDGE_SERVER_NAME}`] : []), ...(worker ? ['functions'] : [])]
    return createCodexAppServer({
        defaultSettings: {
            ...shared,
            ...(desktop && {
                env: {
                    ...shared.env,
                    RERUN_DESKTOP_CODEX_WEB: native.webSearch ? '1' : '0',
                    RERUN_DESKTOP_CODEX_CODE_MODE: native.codeMode ? '1' : '0',
                    RERUN_NATIVE_EXEC_URL: worker?.url ?? '',
                    RERUN_NATIVE_SHELL: worker && native.shell ? '1' : '0',
                },
            }),
            ...(worker && { cwd: worker.cwd }),
            approvalPolicy: 'never',
            sandboxPolicy: worker ? { type: 'externalSandbox', networkAccess: 'restricted' } : desktop ? 'read-only' : 'danger-full-access',
            autoApprove: !desktopApp(),
            // A thread written to disk, so the next message can resume it: the run passes its id
            // back (see `codexThreadToResume`), and Codex keys OpenAI's prompt cache on it.
            threadMode: 'persistent',
            minCodexVersion: CODEX_MIN_VERSION,
            rmcpClient: true,
            personality: 'none',
            // The Rerun prompt replaces Codex's base instructions rather than following them as
            // developer instructions, so the model reads one identity, not two.
            ...(options.system !== undefined ? { baseInstructions: options.system } : {}),
            // Pin the tool namespace: without it recent Codex builds expose the bridged tools as
            // `rerun__ask_user` on some versions and `mcp__rerun__ask_user` on others.
            // The reasoning summary is stated rather than left to whichever Codex build the box has
            // installed, so the chat shows the same thing everywhere.
            configOverrides: {
                model_reasoning_summary: 'auto',
                ...(desktop ? {
                    project_doc_max_bytes: 0,
                    web_search: native.webSearch ? 'live' : 'disabled',
                    'features.code_mode.enabled': native.codeMode,
                    'features.code_mode.excluded_tool_namespaces': worker ? ['collaboration', 'clock'] : ['functions', 'collaboration', 'clock'],
                    ...(!native.codeMode && directNamespaces.length > 0 && { 'features.code_mode.direct_only_tool_namespaces': directNamespaces }),
                    ...(names.length > 0 && {
                        prefix_mcp_tool_names: true,
                        [`mcp_servers.${BRIDGE_SERVER_NAME}.enabled_tools`]: names,
                        // Each registered action is separately granted and rechecked by its own handler.
                        ...Object.fromEntries(names.map(name => [`mcp_servers.${BRIDGE_SERVER_NAME}.tools.${name}.approval_mode`, 'approve'])),
                    }),
                } : {
                    prefix_mcp_tool_names: true,
                    [`mcp_servers.${BRIDGE_SERVER_NAME}.tool_timeout_sec`]: BRIDGE_TOOL_TIMEOUT_SEC,
                    ...CODEX_HARNESS_OVERRIDES,
                    ...(agent.config.tools.web ? { web_search: 'live' } : {}),
                }),
            },
            mcpServers: desktop ? codexMcpConfig(localTools, [], options.screenshots) : codexMcpConfig(tools, mcpServers),
        },
    })
}

// The two providers that speak the OpenAI chat format to OpenRouter: the keyless `rerun` one
// through the hub proxy, and the user's own key straight to OpenRouter (or to the router they
// pointed their connection at).
function openrouterCompatibleOptions(agent: LoadedAgent, provider: 'rerun' | 'openrouter'): Parameters<typeof createOpenAI>[0] {
    if (provider === 'rerun') {
        const { RERUN_HUB_BASE_URL: hub, RERUN_API_KEY: hubKey } = env()
        return { apiKey: hubKey ?? '', baseURL: `${(hub ?? '').replace(/\/$/, '')}/api/llm`, headers: hubCallerHeaders(agent) }
    }
    return {
        apiKey: connectionEnv(agent).OPENROUTER_API_KEY,
        baseURL: (agent.resolved.connection?.config.baseUrl || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    }
}

function registryFor(agent: LoadedAgent, tools?: ToolSet, mcpServers?: McpServer[], options?: CliModelOptions) {
    const e = connectionEnv(agent)
    return createProviderRegistry({
        rerun: openaiChat(openrouterCompatibleOptions(agent, 'rerun')),
        anthropic: createAnthropic({ apiKey: e.ANTHROPIC_API_KEY }),
        ...(!desktopApp() ? { claude: claudeProvider(agent, tools, mcpServers, undefined, options) } : {}),
        ...(!desktopApp() || agent.resolved.provider === 'codex' ? { codex: codexExecProvider(agent) } : {}),
        openai: createOpenAI({ apiKey: e.OPENAI_API_KEY }),
        google: createGoogleGenerativeAI({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY ?? e.GOOGLE_API_KEY }),
        openrouter: openaiChat(openrouterCompatibleOptions(agent, 'openrouter')),
    })
}

// A run's model, as asked for. The provider is the connection's — the override only ever names a
// connection and a model, and `runtime/loop.ts` derives the provider from the resolved connection.
export type ModelOverride = { connectionId?: string; provider?: Provider; model?: string }

// `agent.resolved` already applied the agent's pin, the box default and the fallbacks, so it is
// what a caller with no override of its own (compaction, curator, vision, memory reconcile) means.
function pairFor(agent: LoadedAgent, override?: ModelOverride): { provider: Provider; model: string } {
    const provider = agent.resolved.provider
    assertDesktopProvider(provider, agent.resolved.connection?.id)
    if (provider === 'custom' && (!desktopApp() || !agent.resolved.connection?.custom)) throw new Error('This custom connection is unavailable.')
    if (desktopApp() && provider === 'codex' && agent.resolved.connection?.env[signedInFlag] !== '1') throw new Error('Sign in to ChatGPT in Settings.')
    return { provider, model: allowedModel(provider, override?.model ?? agent.resolved.model) }
}

function subscriptionModel(agent: LoadedAgent, model: string, reasoning?: string) {
    const id = agent.resolved.connection?.id
    const pin = parseDesktopSubscriptionConnectionId(id)
    const connection = id && findDesktopSubscriptionConnection(id)
    const selected = connection && connection.config.subscriptionModels?.find(item => item.id === model)
    if (!pin || !selected || pin.provider !== agent.resolved.provider) throw new Error('The selected subscription model is unavailable.')
    return createDesktopSubscriptionModel({
        ...pin, model, reasoning: reasoning ?? selected.reasoning?.default,
    })
}

function opencodeModel(agent: LoadedAgent, model: string, sessionId?: string) {
    const connection = agent.resolved.connection
    if (!connection?.opencode || isCredentialRejected(connection.id)) throw new Error('Connect OpenCode in Settings.')
    return desktopOpencodeLanguageModel({
        workspaceId: connection.opencode.workspaceId, connectionId: connection.id, modelId: model, sessionId,
        enabledModelIds: connection.opencode.enabledModelIds, consoleEnabled: connection.opencode.consoleEnabled,
        credential: signal => desktopOpencodeCredential(connection, signal),
    })
}

// For one-shot calls with no tools. Codex resolves to the exec transport here, which spawns per call
// and exits — nothing to dispose. A run that streams must use `resolveModel` instead.
export function modelFor(agent: LoadedAgent, override?: ModelOverride, tools?: ToolSet, mcpServers?: McpServer[], options?: CliModelOptions): LanguageModel {
    const { provider, model } = pairFor(agent, override)
    if (provider === 'opencode') {
        const entry = opencodeModel(agent, model)
        return wrapLanguageModel({ model: entry.model, middleware: entry.middleware })
    }
    if (provider === 'custom') return customInferenceModel(agent.resolved.connection, model).model
    if (isDesktopSubscriptionProvider(provider)) return subscriptionModel(agent, model).model
    if (desktopApp() && provider === 'codex' && options?.desktopVision) {
        return wrapLanguageModel({
            model: codexExecProvider(agent).languageModel(model),
            middleware: {
                specificationVersion: 'v3',
                async wrapGenerate({ params }) {
                    // The exec SDK writes images outside the sandbox. App-server accepts bytes
                    // inline, with no filesystem grant or live workspace path in the request.
                    const codex = createCodexAppServer({ defaultSettings: {
                        ...desktopCodexRuntime(),
                        threadMode: 'stateless',
                        minCodexVersion: CODEX_MIN_VERSION,
                        sandboxPolicy: 'read-only',
                        approvalPolicy: 'never',
                        autoApprove: false,
                        baseInstructions: CODEX_ONE_SHOT_INSTRUCTIONS,
                    } })
                    try { return await codex(model).doGenerate(params) }
                    finally { await codex.close() }
                },
            },
        })
    }
    if (desktopApp() && provider === 'claude') {
        // One-shot helpers may reuse the model. Each invocation gets an isolated process owner;
        // the metadata-only model below is never invoked by either middleware path.
        const create = () => {
            const runtime = desktopClaudeRuntime(agent.resolved.connection?.id, connectionEnv(agent).CLAUDE_CODE_OAUTH_TOKEN ?? '', CLAUDE_HARNESS_ENV)
            try { return { runtime, model: claudeProvider(agent, tools, mcpServers, undefined, options, runtime).languageModel(model) } }
            catch (error) { void runtime.close(); throw error }
        }
        return wrapLanguageModel({ model: createClaudeCode().languageModel(model), middleware: {
            specificationVersion: 'v3',
            async wrapGenerate({ params }) {
                const owned = create()
                try { return await owned.model.doGenerate(params) } finally { await owned.runtime.close() }
            },
            async wrapStream({ params }) {
                const owned = create()
                try {
                    const result = await owned.model.doStream(params), reader = result.stream.getReader()
                    return { ...result, stream: new ReadableStream({
                        async pull(controller) {
                            try {
                                const part = await reader.read()
                                if (part.done) { await owned.runtime.close(); controller.close() }
                                else controller.enqueue(part.value)
                            } catch (error) { await owned.runtime.close(); controller.error(error) }
                        },
                        async cancel(reason) { try { await reader.cancel(reason) } finally { await owned.runtime.close() } },
                    }) }
                } catch (error) { await owned.runtime.close(); throw error }
            },
        } })
    }
    return registryFor(agent, tools, mcpServers, options).languageModel(`${provider}:${model}`)
}

// A model plus whatever has to be torn down once the run is over. Only the Codex app-server holds a
// process; every other provider closes to a no-op. `contextUsage` reads the context window occupancy
// a claude run captured via its Stop hook — the cumulative usage the provider reports at finish
// counts cache reads once per internal turn and says nothing about how full the window is.
// `quickReplies` reads the block the model closed its message with, cut out of the text on its way.
export type ResolvedModel = { model: LanguageModel; close: () => Promise<void>; contextUsage?: () => ContextOccupancy | undefined; quickReplies: () => QuickRepliesCapture | undefined }

const noClose = async (): Promise<void> => {}

export function resolveModel(agent: LoadedAgent, override?: ModelOverride, tools?: ToolSet, mcpServers?: RunMcpServer[], system?: string, screenshots?: ScreenshotLookup, nativeWorker?: DesktopNativeWorker, imageRun?: DesktopCodexImageRun, reasoningEffort?: string, sessionId?: string): ResolvedModel {
    const { provider, model } = pairFor(agent, override)
    // `wrapLanguageModel` runs the list from the end: the guard sits nearest the model, so no other
    // middleware ever reads a fake tool call, the card tags go next, and the quick replies read the
    // text right after them.
    const replies = createQuickRepliesCapture()
    const cardTags = createCardTagGuard(agent.id, provider)
    const guard = createFakeToolCallGuard(agent.id)
    if (provider === 'opencode') {
        const entry = opencodeModel(agent, model, sessionId)
        return { model: wrapLanguageModel({ model: entry.model, middleware: [replies.middleware, cardTags, ...entry.middleware, guard] }), close: noClose, quickReplies: replies.read }
    }
    if (isDesktopSubscriptionProvider(provider)) {
        const subscription = subscriptionModel(agent, model, reasoningEffort)
        return { model: wrapLanguageModel({ model: subscription.model, middleware: [replies.middleware, cardTags, guard] }), close: subscription.close, quickReplies: replies.read }
    }
    if (provider === 'custom') {
        const custom = customInferenceModel(agent.resolved.connection, model, reasoningEffort, sessionId ? { agentId: agent.id, sessionId } : undefined)
        return { model: wrapLanguageModel({ model: custom.model, middleware: [replies.middleware, cardTags, guard] }), close: custom.close, quickReplies: replies.read }
    }
    if (provider === 'codex') {
        const codex = codexAppServerProvider(agent, tools, mcpServers, { system, screenshots, nativeWorker })
        // Accepts an already-named image_generation result for this run. The 0.166 CLI patch is not
        // changed here, so a live ChatGPT image turn stays a root gate. Other adapters never get this.
        const image = imageRun && desktopApp()
            ? createDesktopCodexImageMiddleware({ provider, agent, ...imageRun })
            : undefined
        const middleware = [codexMcpCompatibilityMiddleware, replies.middleware, cardTags, ...(image ? [image] : []), guard]
        return { model: wrapLanguageModel({ model: codex(model), middleware }), close: () => codex.close(), quickReplies: replies.read }
    }
    if (provider === 'claude') {
        const capture = claudeContextCapture(agent.resolved.connection?.id)
        const desktopRuntime = desktopApp() ? desktopClaudeRuntime(agent.resolved.connection?.id, connectionEnv(agent).CLAUDE_CODE_OAUTH_TOKEN ?? '', CLAUDE_HARNESS_ENV) : undefined
        const claude = claudeProvider(agent, tools, mcpServers, capture, { system, screenshots, claudeTools: agent.config.tools.web ? CLAUDE_RUN_TOOLS : [] }, desktopRuntime).languageModel(model)
        return { model: wrapLanguageModel({ model: claude, middleware: [claudeScreenshotMiddleware, replies.middleware, cardTags, guard] }), close: desktopRuntime?.close ?? noClose, contextUsage: capture.read, quickReplies: replies.read }
    }
    // Asking for the reasoning and reading it back are both off the OpenAI chat format, so they are
    // wired here rather than in the registry: the one-shot calls that go through `modelFor`
    // (compaction, curator, vision, memory reconcile) have no one to show a thought to.
    if (provider === 'rerun' || provider === 'openrouter') {
        const openrouter = openaiChat({ ...openrouterCompatibleOptions(agent, provider), fetch: provider === 'openrouter' ? cacheBreakpointsFetch(reasoningFetch) : reasoningFetch })
        return { model: wrapLanguageModel({ model: openrouter.languageModel(model), middleware: [openrouterStreamRetryMiddleware, openrouterReasoningMiddleware, replies.middleware, cardTags, guard] }), close: noClose, quickReplies: replies.read }
    }
    const middleware = provider === 'google' ? [googleToolSchemaMiddleware, replies.middleware, cardTags, guard] : [replies.middleware, cardTags, guard]
    return { model: wrapLanguageModel({ model: registryFor(agent, tools, mcpServers).languageModel(`${provider}:${model}`), middleware }), close: noClose, quickReplies: replies.read }
}
