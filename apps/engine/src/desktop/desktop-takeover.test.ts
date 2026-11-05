import {expect,it} from 'vitest'
import {desktopTakeoverInput,findDesktopTakeover} from '@rerun/contracts'
const request={url:'https://example.com/login',reason:'Sign in'}
const row=(id:string,role:string,parts:unknown)=>({id,role,contentJson:JSON.stringify(parts)})
const call=row('source','assistant',[{type:'tool-call',toolName:'mcp__rerun__request_takeover',toolCallId:'tool',input:request}])
const receipt=row('result','tool',[{type:'tool-result',toolCallId:'tool',output:{type:'json',value:{status:'delivered'}}}])
it('requires a delivered exact request and invalidates it after another user or tool',()=>{
 expect(findDesktopTakeover([call])).toBeNull()
 expect(findDesktopTakeover([call,receipt])).toMatchObject({...request,sourceMessageId:'source',toolCallId:'tool',fingerprint:JSON.stringify(request)})
 expect(findDesktopTakeover([call,receipt,row('new','user','done')])).toBeNull()
 expect(findDesktopTakeover([call,receipt,row('other','assistant',[{type:'tool-call',toolName:'computer',toolCallId:'other',input:{action:'screenshot'}}])])).toBeNull()
})
it('rejects credentials, oversized instructions and non-web URLs',()=>{
 for(const url of ['file:///private/x','https://name:secret@example.com/','data:text/html,test'])expect(desktopTakeoverInput({...request,url})).toBeNull()
 expect(desktopTakeoverInput({...request,reason:'x'.repeat(201)})).toBeNull()
})
