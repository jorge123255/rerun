import 'server-only'
import {z} from 'zod'
import type {Client,Row} from '@libsql/client'
import {sealHeaderBundle,openStoredHeaderBundle} from '../accounts/header-secret-codec'
import type {OAuthAttempt,OAuthAttemptStore} from './ports'
import type {OAuthTokenBundle} from '../../mcp/store'
export const SERVICE_OAUTH_SCHEMA_SQL=[
 `CREATE TABLE desktop_service_oauth_attempts(owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,attempt_id TEXT NOT NULL,request_id TEXT NOT NULL,installation_id TEXT NOT NULL,revision TEXT NOT NULL,state TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(owner,attempt_id),UNIQUE(owner,request_id))`,
 `CREATE UNIQUE INDEX desktop_service_oauth_active ON desktop_service_oauth_attempts(owner,installation_id) WHERE state IN ('starting','waiting','checking','connected')`,
 `CREATE TABLE desktop_service_oauth_tokens(owner TEXT NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,installation_id TEXT NOT NULL,config_generation TEXT NOT NULL,token_generation TEXT NOT NULL,bundle TEXT NOT NULL,PRIMARY KEY(owner,installation_id))`,
] as const
const tokenSchema=z.object({accessToken:z.string().min(1).max(8192),refreshToken:z.string().max(8192).optional(),expiresAt:z.number().finite(),resource:z.string().url(),issuer:z.string().url(),tokenEndpoint:z.string().url(),clientId:z.string().min(1).max(2048),scope:z.string().max(8192).optional(),refreshPending:z.string().max(200).optional()}).strict()
const decode=(row:Row):OAuthAttempt=>{const record=JSON.parse(String(row.record)) as OAuthAttempt;if(record.version!==1)throw new Error('Unsupported OAuth attempt');return record}
const identity=(a:OAuthAttempt)=>[a.binding.owner,a.snapshot.attemptId]
export function sqliteServiceOAuthStore(db:Client,keyReader:()=>Buffer):OAuthAttemptStore{
 const read=async(owner:string,id:string)=>{const row=(await db.execute({sql:'SELECT record FROM desktop_service_oauth_attempts WHERE owner=? AND attempt_id=?',args:[owner,id]})).rows[0];return row?decode(row):null}
 // The canonical account row must be an OAuth row at the exact revision, never a header account.
 const accountWhere=`EXISTS(SELECT 1 FROM desktop_service_installs s WHERE s.owner=? AND s.id=? AND s.engine_id=? AND s.revision=? AND s.state IN ('preparing','ready') AND json_extract(s.plan,'$.shape')='oauth' AND json_extract(s.plan,'$.url')=? AND json_extract(s.plan,'$.methodId')=?)`
 const accountArgs=(a:OAuthAttempt)=>[a.binding.owner,a.binding.installationId,a.binding.engineId,a.binding.configGeneration,a.binding.endpoint,a.binding.methodId]
 return {read,
  async reserve(attempt){
   await db.execute({sql:'INSERT INTO desktop_service_oauth_attempts(owner,attempt_id,request_id,installation_id,revision,state,record) VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,request_id) DO NOTHING',args:[...identity(attempt),attempt.requestId,attempt.binding.installationId,attempt.snapshot.revision,attempt.snapshot.state,JSON.stringify(attempt)]})
   const row=(await db.execute({sql:'SELECT record FROM desktop_service_oauth_attempts WHERE owner=? AND request_id=?',args:[attempt.binding.owner,attempt.requestId]})).rows[0]
   if(!row)throw new Error('OAuth reservation unavailable')
   const saved=decode(row)
   if(saved.fingerprint!==attempt.fingerprint)throw new Error('OAuth request identity conflict')
   return {created:saved.snapshot.attemptId===attempt.snapshot.attemptId,attempt:saved}
  },
  async list(owner){const rows=await db.execute(owner?{sql:'SELECT record FROM desktop_service_oauth_attempts WHERE owner=? ORDER BY rowid LIMIT 2049',args:[owner]}:'SELECT record FROM desktop_service_oauth_attempts ORDER BY rowid LIMIT 2049');if(rows.rows.length>2048)throw new Error('OAuth attempt retention limit reached');return rows.rows.map(decode)},
  async save(attempt,expectedRevision){
   const result=await db.execute({sql:'UPDATE desktop_service_oauth_attempts SET revision=?,state=?,record=? WHERE owner=? AND attempt_id=? AND revision=?',args:[attempt.snapshot.revision,attempt.snapshot.state,JSON.stringify(attempt),...identity(attempt),expectedRevision]})
   if(result.rowsAffected!==1)throw new Error('OAuth attempt changed')
  },
  async readToken(attempt){
   const row=(await db.execute({sql:`SELECT bundle FROM desktop_service_oauth_tokens WHERE owner=? AND installation_id=? AND config_generation=? AND token_generation=? AND ${accountWhere}`,args:[attempt.binding.owner,attempt.binding.installationId,attempt.binding.configGeneration,attempt.snapshot.attemptId,...accountArgs(attempt)]})).rows[0]
   if(!row)return null
   const opened=openStoredHeaderBundle(keyReader(),attempt.binding.owner,`oauth:${attempt.binding.installationId}`,`${attempt.binding.configGeneration}:${attempt.snapshot.attemptId}`,String(row.bundle))
   return tokenSchema.parse(JSON.parse(opened.inputs.token)) as OAuthTokenBundle
  },
  async writeToken(attempt,bundle,signal){
   signal.throwIfAborted()
   const checked=tokenSchema.parse(bundle)
   if(checked.resource!==attempt.binding.endpoint)throw new Error('OAuth resource mismatch')
   const ciphertext=sealHeaderBundle(keyReader(),attempt.binding.owner,`oauth:${attempt.binding.installationId}`,`${attempt.binding.configGeneration}:${attempt.snapshot.attemptId}`,{headers:{},inputs:{token:JSON.stringify(checked)}})
   const previous=(await db.execute({sql:'SELECT * FROM desktop_service_oauth_tokens WHERE owner=? AND installation_id=?',args:[attempt.binding.owner,attempt.binding.installationId]})).rows[0]
   const result=await db.execute({sql:`INSERT INTO desktop_service_oauth_tokens(owner,installation_id,config_generation,token_generation,bundle) SELECT ?,?,?,?,? WHERE ${accountWhere} AND EXISTS(SELECT 1 FROM desktop_service_oauth_attempts WHERE owner=? AND attempt_id=? AND state IN ('starting','waiting','checking','connected')) ON CONFLICT(owner,installation_id) DO UPDATE SET config_generation=excluded.config_generation,token_generation=excluded.token_generation,bundle=excluded.bundle`,args:[attempt.binding.owner,attempt.binding.installationId,attempt.binding.configGeneration,attempt.snapshot.attemptId,ciphertext,...accountArgs(attempt),...identity(attempt)]})
   if(result.rowsAffected!==1)throw new Error('OAuth credential generation changed')
   if(signal.aborted){
    if(previous)await db.execute({sql:'UPDATE desktop_service_oauth_tokens SET config_generation=?,token_generation=?,bundle=? WHERE owner=? AND installation_id=? AND bundle=?',args:[String(previous.config_generation),String(previous.token_generation),String(previous.bundle),attempt.binding.owner,attempt.binding.installationId,ciphertext]})
    else await db.execute({sql:'DELETE FROM desktop_service_oauth_tokens WHERE owner=? AND installation_id=? AND bundle=?',args:[attempt.binding.owner,attempt.binding.installationId,ciphertext]})
    signal.throwIfAborted()
   }
  },
  async clearToken(attempt){await db.execute({sql:'DELETE FROM desktop_service_oauth_tokens WHERE owner=? AND installation_id=? AND config_generation=? AND token_generation=?',args:[attempt.binding.owner,attempt.binding.installationId,attempt.binding.configGeneration,attempt.snapshot.attemptId]})},
 }
}
