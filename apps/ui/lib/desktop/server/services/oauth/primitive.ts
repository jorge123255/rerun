import 'server-only'
import {createHash} from 'node:crypto'
import {loopbackMcpOAuth} from '../../mcp/oauth-loopback'
import {remoteMcpLifecycle} from '../../mcp/lifecycle'
import type {RemoteMcpStore} from '../../mcp/store'
import type {OAuthJson} from '../../mcp/oauth-network'
import type {OAuthAccounts,OAuthAttemptStore,OAuthPrimitiveFactory} from './ports'
export function catalogOAuthPrimitive(accounts:OAuthAccounts,store:OAuthAttemptStore,json?:OAuthJson):OAuthPrimitiveFactory{
 return (attempt,guard)=>{
  const binding=attempt.binding,name=`oauth-${createHash('sha256').update(binding.installationId).digest('hex').slice(0,40)}`,lifecycle=remoteMcpLifecycle()
  const exact=(owner:string,alias:string,revision?:string)=>{if(owner!==binding.owner||alias!==name||revision!==undefined&&revision!==binding.configGeneration)throw new Error('OAuth account identity changed')}
  const adapter:RemoteMcpStore={lifecycle,list:async()=>[],
   async read(owner,alias){exact(owner,alias);await guard(AbortSignal.timeout(5000));return {name,url:binding.endpoint,revision:binding.configGeneration,bearer:''}},
   async readOAuth(owner,alias){exact(owner,alias);return store.readToken(attempt)},
   async writeOAuth(owner,alias,revision,bundle,signal){exact(owner,alias,revision);await lifecycle.commitCredentials(owner,alias,signal,async check=>accounts.exclusive(owner,binding.installationId,async()=>{check();await guard(signal);await store.writeToken(attempt,bundle,signal);check();await guard(signal)}))},
   save:async()=>{throw new Error('OAuth account configuration is owned by the service lifecycle')},remove:async()=>{throw new Error('OAuth account removal is owned by the service lifecycle')},
  }
  const primitive=loopbackMcpOAuth(adapter,async owner=>{if(owner!==binding.owner)throw new Error('OAuth owner changed');const now=await accounts.current(owner,binding.accountKey,AbortSignal.timeout(5000));return {enabled:now.enabled,granted:now.granted}},json)
  return {start:signal=>primitive.start(binding.owner,name,binding.configGeneration,signal),status:signal=>primitive.status(binding.owner,name,binding.configGeneration,signal),credential:signal=>primitive.credential(binding.owner,name,binding.configGeneration,signal),cancel:signal=>primitive.cancel(binding.owner,name,binding.configGeneration,signal),shutdown:()=>primitive.shutdown()}
 }
}
