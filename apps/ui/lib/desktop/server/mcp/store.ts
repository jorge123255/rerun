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
        const result = await db.execute({ sql: 'SELECT name,url,revision,bearer IS NOT NULL AS has_bearer FROM desktop_remote_mcp WHERE agent_id=? ORDER BY name', args:[agent] })
        return result.rows.map(r => ({ name:String(r.name), url:String(r.url), revision:String(r.revision), hasBearer:!!r.has_bearer }))
    }
    return {
        list, lifecycle,
        async readOAuth(agent:string,name:string):Promise<OAuthTokenBundle|null> {
            const row=(await db.execute({sql:'SELECT o.bundle FROM desktop_remote_mcp_oauth o JOIN desktop_remote_mcp s ON s.agent_id=o.agent_id AND s.name=o.name AND s.revision=o.revision WHERE o.agent_id=? AND o.name=?',args:[agent,name]})).rows[0]
            return row?JSON.parse(open(agent,`oauth:${name}`,String(row.bundle))):null
        },
        async writeOAuth(agent:string,name:string,revision:string,bundle:OAuthTokenBundle,signal:AbortSignal) {
            return lifecycle.commitCredentials(agent,name,signal,async check=>{
                check()
                const previous=(await db.execute({sql:'SELECT revision,bundle FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=?',args:[agent,name]})).rows[0]
                check()
                const encrypted=seal(agent,`oauth:${name}`,JSON.stringify(bundle))
                try {
                    const result=await db.execute({sql:'INSERT INTO desktop_remote_mcp_oauth(agent_id,name,revision,bundle) SELECT agent_id,name,revision,? FROM desktop_remote_mcp WHERE agent_id=? AND name=? AND revision=? ON CONFLICT(agent_id,name) DO UPDATE SET revision=excluded.revision,bundle=excluded.bundle',args:[encrypted,agent,name,revision]})
                    check()
                    if(result.rowsAffected!==1)throw new Error('MCP server changed')
                } catch(error) {
                    // Restore only the row displaced by this exact write. In particular, a
                    // cancelled refresh must retain its prior uncertain-rotation receipt,
                    // rather than looking anonymous on the next request or after restart.
                    if(previous)await db.execute({sql:'UPDATE desktop_remote_mcp_oauth SET revision=?,bundle=? WHERE agent_id=? AND name=? AND bundle=?',args:[String(previous.revision),String(previous.bundle),agent,name,encrypted]})
                    else await db.execute({sql:'DELETE FROM desktop_remote_mcp_oauth WHERE agent_id=? AND name=? AND bundle=?',args:[agent,name,encrypted]})
                    throw error
                }
            })
        },
        async read(agent: string, name: string) {
            const row = (await db.execute({ sql:'SELECT * FROM desktop_remote_mcp WHERE agent_id=? AND name=?',args:[agent,name] })).rows[0]
            if (!row) throw new Error('MCP server unavailable')
            return { name:String(row.name), url:String(row.url), revision:String(row.revision), bearer:row.bearer ? open(agent,name,String(row.bearer)) : '' }
        },
        async save(agent: string, input: { name:string; url:string; bearer?:string; revision?:string }) {
            return lifecycle.mutate(agent,input.name,async () => {
            const name = serverName(input.name), url = endpoint(input.url)
            if (input.bearer !== undefined && (!/^[\x21-\x7e]*$/.test(input.bearer) || input.bearer.length > 8192)) throw new Error('Invalid bearer')
            // Optimistic revision guard makes edits atomic and prevents silently losing a credential change.
            const bearer = input.bearer === undefined ? undefined : input.bearer ? seal(agent,name,input.bearer) : null
            const rev = randomUUID()
            if (input.revision) {
                const result = await db.execute({sql: `UPDATE desktop_remote_mcp SET url=?,revision=?,bearer=${bearer === undefined ? 'bearer' : '?'} WHERE agent_id=? AND name=? AND revision=?`,args:[url,rev,...(bearer === undefined ? [] : [bearer]),agent,name,input.revision]})
                if (result.rowsAffected !== 1) throw new Error('MCP server changed; reload')
            } else await db.execute({sql:'INSERT INTO desktop_remote_mcp(agent_id,name,url,revision,bearer) VALUES(?,?,?,?,?)',args:[agent,name,url,rev,bearer ?? null]})
            return list(agent)
            })
        },
        async remove(agent:string,name:string,revision:string) {
            return lifecycle.mutate(agent,name,async () => {
            const result = await db.execute({sql:'DELETE FROM desktop_remote_mcp WHERE agent_id=? AND name=? AND revision=?',args:[agent,name,revision]})
            if (result.rowsAffected !== 1) throw new Error('MCP server changed; reload')
            return list(agent)
            })
        },
    }
}
export type RemoteMcpStore = ReturnType<typeof remoteMcpStore>
