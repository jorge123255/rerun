import { agentImageRef, agentWorkspacePathFromHref } from '@rerun/contracts'

import { agentFileRawUrl, sharedFileRawUrl } from './raw-url'

export const AGENT_WORKSPACE_FILE_TAG = 'agent-workspace-file'
export const AGENT_WORKSPACE_FILE_PATH_ATTRIBUTE = 'path'

type MarkdownNode = {
    type?: string
    url?: string
    data?: {
        hName?: string
        hProperties?: Record<string, unknown>
        [key: string]: unknown
    }
    children?: MarkdownNode[]
}

export { agentWorkspacePathFromHref }

/** Where the bytes of an image the agent wrote in Markdown live, through the file proxy. */
export function agentImageSrc(agentId: string, src: string | undefined): string | null {
    const ref = agentImageRef(src)
    if (!ref) return null
    return ref.scope === 'shared' ? sharedFileRawUrl(ref.path) : agentFileRawUrl(agentId, ref.path)
}

/** Rewrites agent workspace links to a custom HAST element, and the agent's own images to the file proxy. */
export function remarkAgentWorkspaceLinks(options?: { agentId?: string; linkPath?: typeof agentWorkspacePathFromHref }) {
    const agentId = options?.agentId
    const linkPath = options?.linkPath ?? agentWorkspacePathFromHref
    return (tree: MarkdownNode) => {
        const visit = (node: MarkdownNode) => {
            if (node.type === 'link') {
                const path = linkPath(node.url)
                if (path) {
                    node.data = {
                        ...node.data,
                        hName: AGENT_WORKSPACE_FILE_TAG,
                        hProperties: {
                            ...node.data?.hProperties,
                            [AGENT_WORKSPACE_FILE_PATH_ATTRIBUTE]: path,
                        },
                    }
                }
            }
            if (node.type === 'image' && agentId) {
                const src = agentImageSrc(agentId, node.url)
                if (src) node.url = src
            }
            node.children?.forEach(visit)
        }

        visit(tree)
    }
}
