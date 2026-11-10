import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createDesktopNotifications, notificationPayload } from '../src/main/notifications.mjs'
const payload = {key:'event:1',kind:'done',agentId:'owner',sessionId:'chat',title:'Coworker',body:'Finished',groupId:'group'}
function fixture(now = Date.now) {
    const notices = [], clicks = [], clickScopes = []
    class Notification extends EventEmitter {
        static isSupported() { return true }
        constructor(options) { super(); this.options = options; notices.push(this) }
        show() { this.shown = true }
        close() { this.emit('close') }
    }
    return { notices, clicks, clickScopes, Notification, bridge:createDesktopNotifications({Notification,onClick:(target,scope)=>{clicks.push(target);clickScopes.push(scope)},timeoutMs:20,now}) }
}
test('only bounded exact notification copy and target fields cross into native notifications',()=>{
    assert.equal(notificationPayload({...payload,kind:'cancelled'}),null)
    assert.equal(notificationPayload({...payload,sessionId:null}),null)
    assert.equal(notificationPayload({...payload,body:'x'.repeat(2049)}),null)
    assert.equal(notificationPayload({...payload,key:'bad\0key'}),null)
    assert.equal(notificationPayload({...payload,key:'k'.repeat(600),terminalId:'t'.repeat(600)}).terminalId.length,600)
    assert.equal(notificationPayload({...payload,key:'k'.repeat(601)}),null)
    assert.equal(notificationPayload({...payload,launchUrl:'https://example.com'}).launchUrl,undefined)
    assert.equal(notificationPayload({...payload,silent:false}).silent,true)
    const info = notificationPayload({...payload,kind:'info',key:'notify-user:owner:chat:run:call',requestId:'notify:owner:chat:run:call',body:'Look here'})
    assert.equal(info.kind,'info')
    assert.equal(info.requestId,'notify:owner:chat:run:call')
    assert.equal(info.body,'Look here')
    assert.equal('title' in info && info.silent,true)
})
test('OS acceptance and duplicate keys share one attempt without claiming a visible banner; clicks contain identity only',async()=>{
    const {notices,clicks,bridge}=fixture()
    const result=bridge.notify(payload),duplicate=bridge.notify(payload)
    assert.equal(result,duplicate);assert.equal(notices.length,1)
    notices[0].emit('show');assert.deepEqual(await result,{status:'accepted'})
    notices[0].emit('click');assert.deepEqual(clicks,[{key:'event:1',kind:'done',agentId:'owner',sessionId:'chat',groupId:'group'}])
    bridge.close();notices[0].emit('click');assert.equal(clicks.length,1)
    assert.deepEqual(await bridge.notify({...payload,key:'second'}),{status:'unavailable'})
})
test('definite native failure permits retry while ambiguous timeout never creates a second attempt',async()=>{
    let time=0
    const {notices,bridge}=fixture(()=>time)
    const first=bridge.notify(payload);notices[0].emit('failed');assert.deepEqual(await first,{status:'failed',diagnostic:'native-failed'})
    assert.deepEqual(await bridge.notify(payload),{status:'unavailable'})
    assert.deepEqual(await bridge.notify({...payload,key:'other'}),{status:'unavailable'})
    assert.equal(notices.length,1)
    time=30_000
    const unknown=bridge.notify(payload)
    await new Promise(resolve=>setTimeout(resolve,30))
    assert.deepEqual(await unknown,{status:'unknown',diagnostic:'observation-timeout'})
    assert.equal(bridge.notify(payload),unknown);assert.equal(notices.length,2)
    bridge.close()
})
test('unsupported native notifications create no attempt',async()=>{
    let attempts=0
    class Notification { static isSupported(){return false} constructor(){attempts++} }
    const bridge=createDesktopNotifications({Notification,onClick:()=>{}})
    assert.deepEqual(await bridge.notify(payload),{status:'unavailable'});assert.equal(attempts,0)
})
test('capacity evicts a settled notice and retains current click routing', async () => {
    const {notices,clicks,bridge}=fixture()
    for (let i=0; i<128; i++) {
        const result=bridge.notify({...payload,key:`event:${i}`})
        notices.at(-1).emit('show')
        assert.deepEqual(await result,{status:'accepted'})
    }
    const next=bridge.notify({...payload,key:'event:128'})
    assert.equal(notices.length,129)
    notices[0].emit('click')
    notices.at(-1).emit('show')
    assert.deepEqual(await next,{status:'accepted'})
    notices.at(-1).emit('click')
    assert.deepEqual(clicks.map(target=>target.key),['event:128'])
    bridge.close()
})

test('failure diagnostic contains only observed stage and never raw native arguments', async () => {
    const {notices,bridge}=fixture()
    const pending=bridge.notify(payload)
    notices[0].emit('failed', {title:'private'}, 'permission denied: secret body')
    assert.deepEqual(await pending,{status:'failed',diagnostic:'native-failed'})
    bridge.close()
})
test('late failure cannot replace an unknown result or settle a newer attempt', async () => {
    let now=0
    const {notices,bridge}=fixture(()=>now)
    const first=bridge.notify(payload)
    notices[0].emit('failed')
    await first
    now=30000
    const next=bridge.notify(payload)
    notices[0].emit('failed', {}, 'private')
    notices[1].emit('show')
    assert.deepEqual(await next,{status:'accepted'})
    bridge.close()
})
test('constructor and show exceptions expose stage only and preserve failed versus unknown', async () => {
    class BrokenConstructor { static isSupported(){return true} constructor(){throw new Error('private title')} }
    const first=createDesktopNotifications({Notification:BrokenConstructor,onClick:()=>{}})
    assert.deepEqual(await first.notify(payload),{status:'failed',diagnostic:'construction-failed'})
    first.close()
    class BrokenShow extends EventEmitter { static isSupported(){return true} show(){throw new Error('private body')} close(){this.emit('close')} }
    const second=createDesktopNotifications({Notification:BrokenShow,onClick:()=>{}})
    assert.deepEqual(await second.notify(payload),{status:'unknown',diagnostic:'show-threw'})
    second.close()
})

test('a notice keeps its submission scope and duplicate keys do not reuse a previous runtime receipt',async()=>{
    const {notices,clickScopes,bridge}=fixture()
    const firstScope={workspaceId:1,launchNonce:'old-runtime'}, current={workspaceId:1,launchNonce:'new-runtime'}
    const first=bridge.notify(payload,firstScope), second=bridge.notify(payload,current)
    assert.equal(bridge.notify(payload,current),second)
    assert.notEqual(first,second)
    assert.equal(notices.length,2)
    for(const notice of notices){notice.emit('show');notice.emit('click')}
    assert.deepEqual(await Promise.all([first,second]),[{status:'accepted'},{status:'accepted'}])
    assert.deepEqual(clickScopes,[firstScope,current])
    bridge.close()
})
