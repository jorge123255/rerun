import { expect, test, vi } from 'vitest'
import { serializeDesktopMcpSignInResult } from '@rerun/contracts'
const source=vi.hoisted(()=>vi.fn())
vi.mock('./source.js',()=>({readDesktopMcpSignInSource:source}))
import { assertDesktopMcpSignInContinuation } from './admission.js'
const guard={runId:'run',sourceMessageId:'message',toolCallId:'call',fingerprint:'fingerprint',server:{name:'linear',revision:'revision',url:'https://linear.example/mcp',displayName:'Linear',host:'linear.example',icon:null}}
test('the queued MCP decision admits only its saved done source and canonical summary',async()=>{
 source.mockResolvedValue({status:'done',guard,input:{name:'linear'}})
 await expect(assertDesktopMcpSignInContinuation('agent','session',guard,serializeDesktopMcpSignInResult('linear','declined'),false)).resolves.toMatchObject({guard})
 expect(source).toHaveBeenLastCalledWith('agent','session',undefined)
 await expect(assertDesktopMcpSignInContinuation('agent','session',guard,'Access token: secret',false)).rejects.toThrow('saved request')
 source.mockResolvedValue({status:'done',guard:{...guard,server:{...guard.server,revision:'replacement'}},input:{name:'linear'}})
 await expect(assertDesktopMcpSignInContinuation('agent','session',guard,serializeDesktopMcpSignInResult('linear','connected'),false)).rejects.toThrow('changed')
 source.mockResolvedValue({status:'cancelled',guard,input:{name:'linear'}})
 await expect(assertDesktopMcpSignInContinuation('agent','session',guard,serializeDesktopMcpSignInResult('linear','declined'),false)).rejects.toThrow('stopped')
})
