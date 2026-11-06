import {createHash} from 'node:crypto'
import {it,expect,vi} from 'vitest'
import type {RemoteMcpStore} from '../../mcp/store'
const captured=vi.hoisted(()=>({store:null as RemoteMcpStore|null}))
vi.mock('server-only',()=>({}))
vi.mock('../../mcp/oauth-loopback',()=>({loopbackMcpOAuth:(store:RemoteMcpStore)=>{captured.store=store;return {start:vi.fn(),status:vi.fn(),credential:vi.fn(),cancel:vi.fn(),shutdown:vi.fn()}}}))
import {catalogOAuthPrimitive} from './primitive'
import type {OAuthAccounts,OAuthAttempt,OAuthAttemptStore} from './ports'
it('binds primitive reads/writes to one account alias, generation and live guard',async()=>{
 const attempt={binding:{owner:'owner',installationId:'installation',endpoint:'https://fixture.example/mcp',configGeneration:'generation',accountKey:'fixture@abc123'},snapshot:{attemptId:'attempt'}} as OAuthAttempt
 const writeToken=vi.fn(),readToken=vi.fn(async()=>null),store={writeToken,readToken} as unknown as OAuthAttemptStore
 const accounts={exclusive:async(_o:string,_i:string,work:()=>Promise<unknown>)=>work()} as unknown as OAuthAccounts
 const guard=vi.fn(async()=>{})
 catalogOAuthPrimitive(accounts,store)(attempt,guard)
 const alias=`oauth-${createHash('sha256').update('installation').digest('hex').slice(0,40)}`
 await expect(captured.store!.read('sibling',alias)).rejects.toThrow('identity')
 await expect(captured.store!.read('owner','other-account')).rejects.toThrow('identity')
 const current=await captured.store!.read('owner',alias)
 expect(current).toMatchObject({revision:'generation',bearer:'',url:'https://fixture.example/mcp'})
 await expect(captured.store!.writeOAuth('owner',alias,'stale',{} as never,new AbortController().signal)).rejects.toThrow('identity')
 expect(writeToken).not.toHaveBeenCalled()
 guard.mockRejectedValueOnce(new Error('removed installation'))
 await expect(captured.store!.writeOAuth('owner',alias,'generation',{} as never,new AbortController().signal)).rejects.toThrow('removed')
 expect(writeToken).not.toHaveBeenCalled()
})
