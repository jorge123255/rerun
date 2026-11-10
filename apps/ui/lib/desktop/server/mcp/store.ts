import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { remoteMcpLifecycle } from './lifecycle'
import { endpoint, serverName, type RemoteServer } from './model'

// Root registers this additive schema. No database is opened or initialized at module load.
export const remoteMcpSchema = `CREATE TABLE IF NOT EXISTS desktop_remote_mcp (
 agent_id TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
 name TEXT NOT NULL, url TEXT NOT NULL, revision TEXT NOT NULL, bearer TEXT,
 PRIMARY KEY(agent_id,name));`
export const remoteMcpOAuthSchema = `CREATE TABLE IF NOT EXISTS desktop_remote_mcp_oauth (
 agent_id TEXT NOT NULL,name TEXT NOT NULL,revision TEXT NOT NULL,bundle TEXT NOT NULL,
 PRIMARY KEY(agent_id,name), FOREIGN KEY(agent_id,name) REFERENCES desktop_remote_mcp(agent_id,name) ON DELETE CASCADE);`
const transportDrains = new WeakMap<object, (owner: string, name: string) => Promise<void>>()
export function bindRemoteTransportDrain(store: Pick<RemoteMcpStore, 'lifecycle'>, drain: (owner: string, name: string) => Promise<void>) {
    if (transportDrains.has(store.lifecycle)) throw new Error('Remote transport cleanup is already bound')
    transportDrains.set(store.lifecycle, drain)
}
export type OAuthTokenBundle={refreshPending?:string;accessToken:string;refreshToken?:string;expiresAt:number;resource:string;issuer:string;tokenEndpoint:string;clientId:string;scope?:string}
export function remoteMcpStore(db: Client, key: () => Buffer) {
    const lifecycle = remoteMcpLifecycle()
    function seal(agent: string, name: string, value: string) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv)
        cipher.setAAD(Buffer.from(JSON.stringify([agent, name])))
        const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    }
    function open(agent: string, name: string, value: string): string {
        const b = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key(), b.subarray(0,12))
        cipher.setAAD(Buffer.from(JSON.stringify([agent, name])))
        cipher.setAuthTag(b.subarray(12,28))
        return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8')
    }
    async function list(agent: string): Promise<RemoteServer[]> {
        const result = await db.execute({ sql: 'SELECT id,transport,name,url,revision,bearer IS NOT NULL AS has_bearer FROM desktop_remote_mcp WHERE agent_id=? ORDER BY name', args:[agent] })
        return result.rows.map(r => ({ id:String(r.id), transport:String(r.transport) as 'http' | 'sse', name:String(r.name), url:String(r.url), revision:String(r.revision), hasBearer:!!r.has_bearer }))
    }
    function commitOAuth(agent:string,name:string,revision:string,bundle:OAuthTokenBundle,signal:AbortSignal,expected?:{registrationId:string;sealed:string|null}) {
        return lifecycle.commitCredentials(agent,name,signal,async check=>{
            check()
            const remote=(await db.execute({sql:'SELECT transport FROM desktop_remote_mcp WHERE agent_id=? AND name=?',args:[agent,name]})).rows[0]
            if(remote?.transport==='sse'){const drain=transportDrains.get(lifecycle);if(!drain)throw new Error('SSE cleanup unavailable');await drain(agent,name);check()}
            const previous=(await db.execute({sql:'SELECT revision,bundle FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?',args:[agent,name]})).rows[0]
            check()
            const encrypted=seal(agent,`oauth:${name}`,JSON.stringify(bundle))
            const predicate = expected ? ' AND id=? AND (SELECT bundle FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?) IS ?' : ''
            const match = expected ? [expected.registrationId, agent, name, expected.sealed] : []
            try {
                const result=await db.execute({sql:`INSERT INTO desktop_remote_mcp_oauth(agent_id,name,revision,bundle) SELECT agent_id,name,revision,? FROM desktop_remote_mcp WHERE agent_id=? AND name=? AND revision=?${predicate} ON CONFLICT(agent_id,name) DO UPDATE SET revision=excluded.revision,bundle=excluded.bundle`,args:[encrypted,agent,name,revision,...match]})
                check()
                if(result.rowsAffected!==1)throw new Error(expected ? 'MCP credential generation changed.' : 'MCP server changed')
            } catch(error) {
                // Restore only the row displaced by this exact write. In particular, a
                // cancelled refresh must retain its prior uncertain-rotation receipt,
                // rather than looking anonymous on the next request or after restart.
                if(previous)await db.execute({sql:'UPDATE desktop_remote_mcp_oauth SET revision=?,bundle=? WHERE agent_id=? AND name=? AND bundle=?',args:[String(previous.revision),String(previous.bundle),agent,name,encrypted]})
                else await db.execute({sql:'DELETE FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=? AND bundle=?',args:[agent,name,encrypted]})
                throw error
            }
            lifecycle.invalidateCredentials(agent,name)
            return encrypted
        })
    }
    return {
        list, lifecycle,
        async readOAuth(agent:string,name:string):Promise<OAuthTokenBundle|null> {
            const row=(await db.execute({sql:'SELECT o.bundle FROM desktop_remote_mcp_oauth o JOIN desktop_remote_mcp s ON s.agent_id=o.agent_id AND s.name=o.name AND s.revision=o.revision WHERE o.agent_id=? AND o.name=?',args:[agent,name]})).rows[0]
            return row?JSON.parse(open(agent,`oauth:${name}`,String(row.bundle))):null
        },
        async credentialState(agent:string,name:string) {
            const row=(await db.execute({sql:`SELECT s.id,s.revision,s.transport,s.bearer IS NOT NULL AS has_bearer,o.bundle
                FROM desktop_remote_mcp s LEFT JOIN desktop_remote_mcp_oauth o ON s.agent_id=o.agent_id AND s.name=o.name
                WHERE s.agent_id=? AND s.name=?`,args:[agent,name]})).rows[0]
            return row && row.transport === 'http' && !row.has_bearer && row.id
                ? { registrationId:String(row.id), revision:String(row.revision), sealed:row.bundle == null ? null : String(row.bundle) } : null
        },
        async writeOAuth(agent:string,name:string,revision:string,bundle:OAuthTokenBundle,signal:AbortSignal) {
            await commitOAuth(agent,name,revision,bundle,signal)
        },
        replaceOAuth(agent:string,name:string,expected:{registrationId:string;revision:string;sealed:string|null},bundle:OAuthTokenBundle,signal:AbortSignal) {
            return commitOAuth(agent,name,expected.revision,bundle,signal,expected)
        },
        async read(agent: string, name: string): Promise<Omit<RemoteServer, 'hasBearer'> & { bearer: string }> {
            const row = (await db.execute({ sql:'SELECT * FROM desktop_remote_mcp WHERE agent_id=? AND name=?',args:[agent,name] })).rows[0]
            if (!row) throw new Error('MCP server unavailable')
            return { id:String(row.id), transport:String(row.transport) as 'http' | 'sse', name:String(row.name), url:String(row.url), revision:String(row.revision), bearer:row.bearer ? open(agent,name,String(row.bearer)) : '' }
        },
        async save(agent: string, input: { name:string; url:string; bearer?:string; revision?:string }) {
            return lifecycle.mutate(agent,input.name,async () => {
            const name = serverName(input.name), url = endpoint(input.url)
            const previous = (await db.execute({sql:'SELECT transport,url,revision FROM desktop_remote_mcp WHERE agent_id=? AND name=?',args:[agent,name]})).rows[0]
            if (previous && previous.transport !== 'http') {
                const drain = transportDrains.get(lifecycle)
                if (!drain || previous.url !== url || previous.revision !== input.revision || input.bearer === undefined) throw new Error('Use the SSE settings for this server')
                await drain(agent, name)
            }
            if (input.bearer !== undefined && (!/^[\x21-\x7e]*$/.test(input.bearer) || input.bearer.length > 8192)) throw new Error('Invalid bearer')
            // Optimistic revision guard makes edits atomic and prevents silently losing a credential change.
            const bearer = input.bearer === undefined ? undefined : input.bearer ? seal(agent,name,input.bearer) : null
            const rev = randomUUID()
            if (input.revision) {
                const result = await db.execute({sql: `UPDATE desktop_remote_mcp SET url=?,revision=?,bearer=${bearer === undefined ? 'bearer' : '?'} WHERE agent_id=? AND name=? AND revision=?`,args:[url,rev,...(bearer === undefined ? [] : [bearer]),agent,name,input.revision]})
                if (result.rowsAffected !== 1) throw new Error('MCP server changed; reload')
            } else await db.execute({sql:'INSERT INTO desktop_remote_mcp(id,transport,agent_id,name,url,revision,bearer) VALUES(?,?,?,?,?,?,?)',args:[randomUUID(),'http',agent,name,url,rev,bearer ?? null]})
            return list(agent)
            })
        },
        async remove(agent:string,name:string,revision:string) {
            return lifecycle.mutate(agent,name,async () => {
            const result = await db.execute({sql:"DELETE FROM desktop_remote_mcp WHERE agent_id=? AND name=? AND revision=? AND transport='http'",args:[agent,name,revision]})
            if (result.rowsAffected !== 1) throw new Error('MCP server changed; reload')
            return list(agent)
            })
        },
    }
}
export type RemoteMcpStore = ReturnType<typeof remoteMcpStore>
