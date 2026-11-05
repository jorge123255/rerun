import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createDesktopNotifications, notificationPayload } from '../src/main/notifications.mjs'
const payload = {key:'event:1',kind:'done',agentId:'owner',sessionId:'chat',title:'Coworker',body:'Finished',groupId:'group'}
function fixture(now = Date.now) {
    const notices = [], clicks = []
    class Notification extends EventEmitter {
        static isSupported() { return true }
        constructor(options) { super(); this.options = options; notices.push(this) }
        show() { this.shown = true }
        close() { this.emit('close') }
    }
    return { notices, clicks, Notification, bridge:createDesktopNotifications({Notification,onClick:target=>clicks.push(target),timeoutMs:20,now}) }
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
})
test('show acknowledgement and duplicate keys share one OS attempt; clicks contain identity only',async()=>{
    const {notices,clicks,bridge}=fixture()
    const result=bridge.notify(payload),duplicate=bridge.notify(payload)
    assert.equal(result,duplicate);assert.equal(notices.length,1)
    notices[0].emit('show');assert.deepEqual(await result,{status:'shown'})
    notices[0].emit('click');assert.deepEqual(clicks,[{key:'event:1',kind:'done',agentId:'owner',sessionId:'chat',groupId:'group'}])
    bridge.close();notices[0].emit('click');assert.equal(clicks.length,1)
    assert.deepEqual(await bridge.notify({...payload,key:'second'}),{status:'unavailable'})
})
test('definite native failure permits retry while ambiguous timeout never creates a second attempt',async()=>{
    let time=0
    const {notices,bridge}=fixture(()=>time)
    const first=bridge.notify(payload);notices[0].emit('failed');assert.deepEqual(await first,{status:'failed'})
    assert.deepEqual(await bridge.notify(payload),{status:'unavailable'})
    assert.deepEqual(await bridge.notify({...payload,key:'other'}),{status:'unavailable'})
    assert.equal(notices.length,1)
    time=30_000
    const unknown=bridge.notify(payload)
    await new Promise(resolve=>setTimeout(resolve,30))
    assert.deepEqual(await unknown,{status:'unknown'})
    assert.equal(bridge.notify(payload),unknown);assert.equal(notices.length,2)
    bridge.close()
})
test('unsupported native notifications create no attempt',async()=>{
    let attempts=0
    class Notification { static isSupported(){return false} constructor(){attempts++} }
    const bridge=createDesktopNotifications({Notification,onClick:()=>{}})
    assert.deepEqual(await bridge.notify(payload),{status:'unavailable'});assert.equal(attempts,0)
})
