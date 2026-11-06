import { Duplex } from 'node:stream'

/** Parses client RFB messages, never WebSocket chunks, before admitting input.
 * Only the guest's RFB 3.7/3.8 NoAuth endpoint is supported. Clipboard writes
 * require the same fresh authority as keys; unknown extensions fail closed. */
export function guardedRfbInput(remote: Duplex, authorize: () => Promise<void>): Duplex {
    let buffered = Buffer.alloc(0), phase: 'version' | 'security' | 'init' | 'messages' = 'version'
    const write = (bytes: Buffer) => new Promise<void>((resolve, reject) => remote.write(bytes, error => error ? reject(error) : resolve()))
    const stream = new Duplex({
        read() { remote.resume() },
        write(chunk: Buffer, _encoding, done) {
            void (async () => {
                if (buffered.length + chunk.length > 131072) throw new Error('Viewer input exceeds limit')
                buffered = Buffer.concat([buffered, chunk])
                while (buffered.length) {
                    let size = 0, input = false, encodingList = false
                    if (phase === 'version') {
                        if (buffered.length < 12) break
                        const version = buffered.subarray(0, 12).toString('ascii')
                        if (version !== 'RFB 003.008\n' && version !== 'RFB 003.007\n') throw new Error('Viewer protocol unavailable')
                        size = 12; phase = 'security'
                    } else if (phase === 'security') {
                        if (buffered[0] !== 1) throw new Error('Viewer security unavailable')
                        size = 1; phase = 'init'
                    } else if (phase === 'init') { size = 1; phase = 'messages' }
                    else {
                        switch (buffered[0]) {
                            case 0: size = 20; break // SetPixelFormat
                            case 2:
                                if (buffered.length < 4) return
                                if (buffered.readUInt16BE(2) > 256) throw new Error('Viewer encodings exceed limit')
                                size = 4 + buffered.readUInt16BE(2) * 4; encodingList = true; break
                            case 3: size = 10; break // FramebufferUpdateRequest
                            case 4: size = 8; input = true; break
                            case 5: size = 6; input = true; break
                            case 6:
                                if (buffered.length < 8) return
                                // Legacy ClientCutText is the explicit Paste path. Extended
                                // clipboard negotiation/data is never admitted here.
                                if (buffered.readInt32BE(4) < 0 || buffered.readUInt32BE(4) > 65536) throw new Error('Viewer clipboard unavailable')
                                size = 8 + buffered.readUInt32BE(4); input = true; break
                            case 150: size = 10; break // EnableContinuousUpdates
                            case 248:
                                if (buffered.length < 9) return
                                if (buffered[8] > 64) throw new Error('Viewer fence exceeds limit')
                                size = 9 + buffered[8]; break
                            case 255:
                                if (buffered.length < 2) return
                                if (buffered[1] !== 0) throw new Error('Viewer extension unavailable')
                                size = 12; input = true; break // QEMU extended key
                            default: throw new Error('Viewer input unavailable')
                        }
                    }
                    if (buffered.length < size) break
                    let packet = Buffer.from(buffered.subarray(0, size)); buffered = buffered.subarray(size)
                    if (encodingList) {
                        // noVNC answers ExtendedClipboard capability negotiation with a
                        // ClientCutText packet even without Paste. Do not advertise a
                        // capability this guarded channel deliberately does not support.
                        // Explicit Paste uses bounded ClientCutText with fresh authority.
                        const encodings: Buffer[] = []
                        for (let offset = 4; offset < packet.length; offset += 4) {
                            if (packet.readUInt32BE(offset) !== 0xc0a1e5ce) encodings.push(packet.subarray(offset, offset + 4))
                        }
                        const header = Buffer.from(packet.subarray(0, 4))
                        header.writeUInt16BE(encodings.length, 2)
                        packet = Buffer.concat([header, ...encodings])
                    }
                    if (input) await authorize()
                    if (stream.destroyed || remote.destroyed) throw new Error('Viewer closed')
                    await write(packet)
                }
            })().then(() => done(), error => done(error instanceof Error ? error : new Error('Viewer input unavailable')))
        },
        final(done) { remote.end(done) },
        destroy(error, done) { buffered = Buffer.alloc(0); remote.destroy(); done(error) },
    })
    remote.on('data', (chunk: Buffer) => { if (!stream.push(chunk)) remote.pause() })
    remote.on('end', () => stream.push(null))
    remote.on('error', () => stream.destroy(new Error('Viewer connection unavailable')))
    remote.on('close', () => { if (!stream.destroyed) stream.destroy() })
    return stream
}
