import { MAX_MEMORIES_PER_CALL, MAX_UPLOAD_MB } from '@/lib/mcp/account-tools'

import { importSource, type ImportSourceId } from './sources'

// Addressed to the outside agent, in English whatever the user's language: it is the one reading
// it. The rules are the ones a model breaks on its own, summarising a long file, passing an API
// key along, creating a second coworker after an error.
//
// `local` is for a Rerun that runs on the person's own Mac: the server takes its key in a header
// rather than in the address, and its file door is narrower than the hosted one.
export function buildImportPrompt(sourceId: ImportSourceId, connectorUrl: string, spaceId: string | null, local?: { header: string }): string {
    const source = importSource(sourceId)
    // The local server wants a request id on every call that writes, so a call sent twice is done
    // once. An ordinary MCP client cannot set a header per call, hence the plain HTTP route first.
    const connect = local
        ? `call this address directly with HTTP POST JSON-RPC 2.0 requests: ${connectorUrl}
Send two headers on every request: "${local.header}" and "x-rerun-external-request-id: <a new UUID>". Use a new UUID for each call; when a call did not answer and you send it again, reuse its UUID so it is not done twice. An MCP client that cannot set that second header can list and read, but its writes are refused.
The requests:`
        : `add this MCP server (streamable HTTP, no other auth needed): ${connectorUrl}
If you cannot add an MCP server, call that URL directly with HTTP POST JSON-RPC 2.0 requests:`
    const files = local
        ? 'Copy your text and Markdown working files (.txt and .md, up to 1 MB each) with upload_workspace_file, one call per file. A file already there is never replaced. Skip everything else.'
        : `Copy your working files with upload_workspace_file, one call per file, base64 for binary files. Skip caches, logs, databases and anything over ${MAX_UPLOAD_MB} MB.`
    const createArgs = spaceId ? `name, description, soul and spaceId "${spaceId}"` : 'name, description and soul'
    return `Move yourself to Rerun, a platform where you will keep working for me as a "coworker". Everything you are and know gets copied there through the Rerun MCP server.

Connect: ${connect} first {"jsonrpc":"2.0","id":1,"method":"tools/list"}, then {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}.

What to read: ${source.whereToLook}

Steps:
1. Call create_agent once, with ${createArgs}. The soul is your full persona and operating instructions, merged into one markdown document. Keep the agentId it returns for every call after.
2. For each skill, call upsert_skill with its name, description, body and reference files.
3. For each scheduled or recurring task, call upsert_schedule with its name, its cron (5 fields) and its instructions as body. A periodic heartbeat check is a scheduled task too.
4. Send what you know about me and what you learned with write_memory, one entry per fact or section, up to ${MAX_MEMORIES_PER_CALL} entries per call.
5. ${files}
6. For each app or service you use (Gmail, Notion, Slack, GitHub...), find it with search_connectors and add it with attach_connector. I will sign in to them from Rerun.

Rules:
- Copy word for word. Never summarise, shorten or rewrite a file.
- Never send an API key, token, password or any other secret.
- Do not pass a model: the coworker runs on my Rerun default.
- create_agent is called once. If a later call fails, fix it and retry that call only.
- This connection expires in 24 hours and only reaches the coworker you create.

When done, call get_agent, compare it with what you sent, then tell me in a short report: what was transferred (counts of skills, scheduled tasks, memories, files), the apps I need to connect in Rerun, and what could not be transferred.`
}
