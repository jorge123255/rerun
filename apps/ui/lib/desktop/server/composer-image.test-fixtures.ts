import { deflateSync } from 'node:zlib'

/** Tiny real RGBA PNGs with valid chunks and compressed scan data. */
export function composerTestPng(red = 255): Uint8Array {
    const chunk = (kind: string, payload: Buffer) => {
        const content = Buffer.concat([Buffer.from(kind, 'ascii'), payload])
        let crc = 0xffffffff
        for (const byte of content) {
            crc ^= byte
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
        }
        const length = Buffer.alloc(4), checksum = Buffer.alloc(4)
        length.writeUInt32BE(payload.length)
        checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
        return Buffer.concat([length, content, checksum])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(1, 0)
    header.writeUInt32BE(1, 4)
    header[8] = 8
    header[9] = 6
    return new Uint8Array(Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.from([0, red, 32, 64, 255]))), chunk('IEND', Buffer.alloc(0)),
    ]))
}
