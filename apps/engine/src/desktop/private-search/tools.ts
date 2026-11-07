import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { RunContext } from '../../runtime/context.js'
import { desktopPrivateRegexSearch } from './files.js'

export function desktopPrivateRegexTools(ctx: RunContext): ToolSet {
    return {
        fs_search: tool({
            description: 'Search visible text files with a regular expression. Returns matching lines as path:line: content. Skips node_modules and .git.',
            inputSchema: z.object({
                pattern: z.string().min(1).max(4096).describe('JavaScript regular expression to match against each line'),
                path: z.string().default('.').describe('Directory to search, relative to the workspace root'),
                maxResults: z.number().int().positive().max(1000).default(200),
            }),
            execute: ({ path, pattern, maxResults }) => desktopPrivateRegexSearch(ctx, path, pattern, maxResults),
        }),
    }
}
