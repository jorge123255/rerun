import { desktopConnectorInnerCalls, stripBridgePrefix } from '@rerun/contracts'
import { desktopBundledLogo, type DesktopCoworkerConnectors } from './connector-apps-schema'
import { humanizeToolSegment, resolveConnectorTool, type ConnectorMap, type ConnectorService } from '@/lib/chat/connector-tools'
import { resolveServiceIcon } from '@/lib/services/icons'
import { isKnownTool } from '@/lib/tool-meta'
import type { ToolIconProps } from '@/hooks/useToolDisplay'

// Which of this coworker's apps a chat tool row belongs to, so the row wears the app's logo and a
// readable tool name. The Mac answers from its own database and bundled catalog in one read per
// coworker; every row of every reply, live or reopened, then resolves from memory.

export { desktopBundledLogo, desktopCoworkerConnectorsSchema, type DesktopCoworkerConnectors, type DesktopConnectorApp } from './connector-apps-schema'

export type DesktopConnectorApps = { servers: ConnectorMap; toolkits: ReadonlyMap<string, ConnectorService> }
export const NO_CONNECTOR_APPS: DesktopConnectorApps = { servers: new Map(), toolkits: new Map() }

export function buildDesktopConnectorApps(listing: DesktopCoworkerConnectors): DesktopConnectorApps {
    const servers = new Map<string, ConnectorService>()
    for (const { server: name, ...service } of listing.servers) if (!servers.has(name)) servers.set(name, { ...service, icon: desktopBundledLogo(service.icon) })
    const toolkits = new Map<string, ConnectorService>()
    for (const { key, ...service } of listing.toolkits) if (!toolkits.has(key)) toolkits.set(key, { ...service, icon: desktopBundledLogo(service.icon) })
    return { servers, toolkits }
}

// Composio names a tool TOOLKIT_ACTION, in capitals. The toolkit may itself hold an underscore
// ("GOOGLE_ANALYTICS_RUN_REPORT"), so the longest run of leading words that names a known app wins.
const TOOLKIT_TOOL = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
function toolkitTool(name: string, toolkits: DesktopConnectorApps['toolkits']): { service: ConnectorService; tool: string } | null {
    if (!toolkits.size || !TOOLKIT_TOOL.test(name)) return null
    const words = name.toLowerCase().split('_')
    for (let count = words.length - 1; count >= 1; count--) {
        const service = toolkits.get(words.slice(0, count).join(''))
        if (service) return { service, tool: words.slice(count).join('_') }
    }
    return null
}

// A tool named in capitals reads as shouting once its underscores are gone.
const calm = (label: string) => /[a-z]/.test(label) ? label : humanizeToolSegment(label.toLowerCase())

/**
 * The app a tool call belongs to and what to call the step, or null when it belongs to none of
 * this coworker's apps: the caller then keeps the row it draws today.
 */
export function resolveDesktopConnectorTool(toolName: string, apps: DesktopConnectorApps, input?: unknown): { label: string; service: ConnectorService } | null {
    const named = apps.servers.size ? resolveConnectorTool(toolName, apps.servers, isKnownTool, input) : null
    if (named) {
        // A step that ran other apps' tools by name wears the first of those apps.
        const first = innerToolkit(toolName, apps, input)
        return { label: calm(named.label), service: first ?? named.service }
    }
    const direct = toolkitTool(toolName, apps.toolkits)
    if (!direct) return null
    // Without a logo the app's name has to stay in the words.
    return { label: direct.service.icon ? humanizeToolSegment(direct.tool) : humanizeToolSegment(toolName.toLowerCase()), service: direct.service }
}

function innerToolkit(toolName: string, apps: DesktopConnectorApps, input: unknown): ConnectorService | null {
    const first = desktopConnectorInnerCalls(toolName, input).tools[0]
    return first ? toolkitTool(first, apps.toolkits)?.service ?? null : null
}

export function desktopConnectorIconProps(service: ConnectorService): ToolIconProps {
    const src = desktopBundledLogo(service.icon)
    return src ? { src } : { icon: resolveServiceIcon(service.icon, service.category) }
}

// Steps the Mac's own runners make that the shared tool map has no entry for: never an app's.
const NATIVE_STEPS = new Set(['exec', 'patch', 'functions.exec', 'image_generation', 'card_file', 'card_table'])

/** Whether a reply holds a step that is not one of Rerun's own tools, and so may belong to an app. */
export function desktopReplyMayUseConnector(parts: readonly { type: string; toolName?: unknown }[]): boolean {
    return parts.some(part => {
        const name = part.type === 'dynamic-tool' ? part.toolName : part.type.startsWith('tool-') ? part.type.slice(5) : undefined
        if (typeof name !== 'string') return false
        const tool = stripBridgePrefix(name)
        return !isKnownTool(tool) && !NATIVE_STEPS.has(tool)
    })
}
