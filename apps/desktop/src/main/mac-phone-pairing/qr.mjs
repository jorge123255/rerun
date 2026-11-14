import { spawn } from 'node:child_process'
import { join } from 'node:path'

export function pairingQrImage(resources, offer) {
    if (!offer.certificateFingerprint || !offer.origin.startsWith('https://')) return Promise.resolve(null)
    const text = JSON.stringify(offer)
    if (Buffer.byteLength(text) > 2048) return Promise.resolve(null)
    // The offer secret goes through a pipe. Keep it out of process arguments and logs.
    return new Promise(resolve => {
        const child = spawn(join(resources, 'runtime/helpers/rerun-pairing-qr'), [], { stdio: ['pipe', 'pipe', 'ignore'] })
        const chunks = []
        let length = 0
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        child.stdout.on('data', chunk => {
            length += chunk.length
            if (length > 128 * 1024) child.kill('SIGKILL')
            else chunks.push(chunk)
        })
        child.stdin.on('error', () => {})
        child.on('error', () => { clearTimeout(timer); resolve(null) })
        child.on('close', code => {
            clearTimeout(timer)
            const png = Buffer.concat(chunks)
            resolve(code === 0 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
                ? 'data:image/png;base64,' + png.toString('base64') : null)
        })
        child.stdin.end(text)
    })
}
