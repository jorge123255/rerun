import { JPEG_QUALITY } from './input.js'

// Same resize as apps/engine/src/desktop/control.ts captureScreen. Bytes stay in memory.
export async function encodeScreenJpeg(png: Buffer, width: number, height: number): Promise<Buffer> {
    const { default: sharp } = await import('sharp')
    return sharp(png).resize(width, height, { fit: 'fill' }).jpeg({ quality: JPEG_QUALITY }).toBuffer()
}
