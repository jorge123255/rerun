import 'server-only'
import { DesktopHttpError } from './auth'
import { DESKTOP_IMAGE_MAX_PIXELS } from './image-bytes'

// The original stores one raster capped at 256px: normalize the orientation, cap the dimensions
// and encode one WebP at the original's quality.
export async function normalizeDesktopIconRaster(bytes: Uint8Array): Promise<Uint8Array> {
    const { default: sharp } = await import('sharp')
    try {
        const webp = await sharp(Buffer.from(bytes), { limitInputPixels: DESKTOP_IMAGE_MAX_PIXELS })
            .rotate()
            .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 82, effort: 6 })
            .toBuffer()
        return new Uint8Array(webp)
    } catch {
        throw new DesktopHttpError(415, 'This image is damaged and can’t be used.')
    }
}
