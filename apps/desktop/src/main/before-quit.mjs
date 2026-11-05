import { randomUUID } from 'node:crypto'

// The caller validates the sender and current desktop document before registration or ACK.
export class BeforeQuitDrafts {
    constructor({ timeoutMs = 10000, schedule = setTimeout, cancel = clearTimeout, nextId = randomUUID } = {}) {
        this.timeoutMs = timeoutMs
        this.schedule = schedule
        this.cancel = cancel
        this.nextId = nextId
        this.registrationId = null
        this.pending = null
    }

    get ready() { return this.registrationId !== null }

    register(registrationId) {
        if (typeof registrationId !== 'string' || !registrationId || registrationId.length > 128) return
        if (registrationId === this.registrationId) return
        this.reset()
        this.registrationId = registrationId
    }

    unregister(registrationId) {
        if (registrationId === this.registrationId) this.reset()
    }

    reset() {
        this.registrationId = null
        this.finish(false)
    }

    request(send) {
        if (!this.ready) return Promise.resolve(true)
        if (this.pending) return this.pending.promise
        let resolve
        const promise = new Promise(done => { resolve = done })
        const pending = { requestId: this.nextId(), registrationId: this.registrationId, promise, resolve }
        this.pending = pending
        pending.timer = this.schedule(() => { if (this.pending === pending) this.finish(false) }, this.timeoutMs)
        try { send({ requestId: pending.requestId, registrationId: pending.registrationId }) }
        catch { if (this.pending === pending) this.finish(false) }
        return promise
    }

    acknowledge(value) {
        const pending = this.pending
        if (!pending || value?.requestId !== pending.requestId || value?.registrationId !== pending.registrationId
            || pending.registrationId !== this.registrationId) return
        this.finish(value.saved === true)
    }

    finish(saved) {
        const pending = this.pending
        if (!pending) return
        this.pending = null
        this.cancel(pending.timer)
        pending.resolve(saved)
    }
}

export async function completeDesktopQuit({ flush, confirmDiscard, stop, quit, cancelled = () => {} }) {
    let saved = false
    try { saved = await flush() === true } catch {}
    if (!saved) {
        let discard = false
        try { discard = await confirmDiscard() === true } catch {}
        if (!discard) { cancelled(); return false }
    }
    // An unconfirmed process drain is not a successful Quit. Restore the existing
    // renderer cancellation protocol so the user can see and retry the error.
    try { await stop() } catch { cancelled(); return false }
    quit()
    return true
}
