import { deflateSync } from 'node:zlib'

const table = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
}

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function chunk(name: string, data: Uint8Array): Uint8Array {
    const type = Buffer.from(name, 'ascii')
    const result = Buffer.alloc(12 + data.length)
    result.writeUInt32BE(data.length, 0)
    result.write(type, 4)
    result.set(data, 8)
    result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length)
    return result
}

export function onePixelPng(): Buffer {
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(1, 0)
    ihdr.writeUInt32BE(1, 4)
    ihdr[8] = 8
    ihdr[9] = 6
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0])),
        chunk('IEND', new Uint8Array()),
    ])
}
