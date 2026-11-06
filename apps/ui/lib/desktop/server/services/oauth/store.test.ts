import {expect,it,vi} from 'vitest'
vi.mock('server-only',()=>({}))
import {sealHeaderBundle,openStoredHeaderBundle} from '../accounts/header-secret-codec'
import {SERVICE_OAUTH_SCHEMA_SQL} from './store'
it('reuses encrypted account codec with disjoint OAuth installation and token-generation AAD',()=>{
 const key=Buffer.alloc(32,7),owner='owner',installation='oauth:installation',generation='config:attempt'
 const sealed=sealHeaderBundle(key,owner,installation,generation,{headers:{},inputs:{token:'fixture-access-and-refresh'}})
 expect(sealed).not.toContain('fixture-access-and-refresh')
 expect(openStoredHeaderBundle(key,owner,installation,generation,sealed).inputs.token).toBe('fixture-access-and-refresh')
 for(const [o,i,g] of [['sibling',installation,generation],[owner,'installation',generation],[owner,installation,'other-attempt']])expect(()=>openStoredHeaderBundle(key,o,i,g,sealed)).toThrow('Secret write conflict')
})
it('schema keeps one live OAuth attempt per canonical installation without touching header tables',()=>{
 expect(SERVICE_OAUTH_SCHEMA_SQL.join('\n')).toContain('UNIQUE INDEX desktop_service_oauth_active')
 expect(SERVICE_OAUTH_SCHEMA_SQL.join('\n')).not.toContain('desktop_service_header_secrets')
})

it('late OAuth token writes cannot revive cancelled attempts or cross account revisions after reopening', async () => {
 const {createClient}=await import('@libsql/client'),{mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {sqliteServiceOAuthStore}=await import('./store'),{desktopServicesSchema}=await import('../schema')
 const dir=await mkdtemp(join(tmpdir(),'rerun-oauth-cas-')),url=`file:${join(dir,'db')}`
 let db=createClient({url})
 try{
  await db.executeMultiple("CREATE TABLE desktop_agents(id TEXT PRIMARY KEY); INSERT INTO desktop_agents VALUES('a');"+desktopServicesSchema+SERVICE_OAUTH_SCHEMA_SQL.join(';')+';')
  const id='00000000-0000-4000-8000-000000000001',revision='00000000-0000-4000-8000-000000000002',attemptId='00000000-0000-4000-8000-000000000003'
  const binding={owner:'a',engineId:'engine',installationId:id,accountKey:'fixture',label:'Fixture',methodId:'oauth',configGeneration:revision,endpoint:'https://example.com/mcp',transport:'http' as const,catalogFingerprint:'catalog',serverName:'fixture'}
  const attempt:import('./ports').OAuthAttempt={version:1,requestId:'00000000-0000-4000-8000-000000000004',fingerprint:'request-digest',binding,probePending:false,snapshot:{attemptId,revision,coworkerId:'a',installationId:id,accountKey:'fixture',label:'Fixture',methodId:'oauth',configGeneration:revision,state:'waiting',expiresAt:Date.now()+60000,configured:false,installed:false,message:'Waiting'}}
  await db.execute({sql:'INSERT INTO desktop_service_installs(owner,key,id,engine_id,slug,method_id,revision,state,plan,health,installed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',args:['a','fixture',id,'engine','fixture','oauth',revision,'ready',JSON.stringify({shape:'oauth',url:binding.endpoint,methodId:'oauth'}),'{}','now']})
  let store=sqliteServiceOAuthStore(db,()=>Buffer.alloc(32,7));await store.reserve(attempt)
  const bundle={accessToken:'fixture-private-access',refreshToken:'fixture-private-refresh',expiresAt:Date.now()+60000,resource:binding.endpoint,issuer:'https://auth.example.com',tokenEndpoint:'https://auth.example.com/token',clientId:'client'}
  await store.writeToken(attempt,bundle,new AbortController().signal)
  const saved=(await db.execute('SELECT bundle FROM desktop_service_oauth_tokens')).rows[0]
  expect(String(saved.bundle)).not.toContain(bundle.accessToken)
  db.close();db=createClient({url});store=sqliteServiceOAuthStore(db,()=>Buffer.alloc(32,7))
  expect((await store.readToken(attempt))?.accessToken).toBe(bundle.accessToken)
  await store.save({...attempt,snapshot:{...attempt.snapshot,revision:'cancelled-revision',state:'cancelled'}},revision)
  await store.clearToken(attempt)
  await expect(store.writeToken(attempt,bundle,new AbortController().signal)).rejects.toThrow()
  expect(await store.readToken(attempt)).toBeNull()
  await db.execute({sql:'UPDATE desktop_service_installs SET revision=? WHERE id=?',args:['replacement-revision',id]})
  await expect(store.writeToken(attempt,bundle,new AbortController().signal)).rejects.toThrow()
 }finally{db.close();await rm(dir,{recursive:true,force:true})}
})
