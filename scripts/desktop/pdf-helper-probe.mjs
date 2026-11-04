import { spawn } from 'node:child_process'

// A self-contained PDF fixture, also used by the packaged-runtime probe. Each
// page paints its full media box, so tests distinguish rendering from a blank PNG.
export function pdfFixture(pages = [{ width: 72, height: 96, color: '1 0 0' }]) {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '']
    const kids = []
    for (const { width, height, color = '1 0 0', rotation = 0 } of pages) {
        const id = objects.length + 1
        kids.push(`${id} 0 R`)
        const stream = `${color} rg\n0 0 ${width} ${height} re f\n`
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotation} /Resources << >> /Contents ${id + 1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`)
    }
    objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`
    let pdf = '%PDF-1.4\n'
    const offsets = [0]
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
    const xref = Buffer.byteLength(pdf)
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(pdf)
}

export function parsePdfRender(bytes) {
    const newline = bytes.indexOf(10)
    if (newline < 1 || newline > 511) throw new Error('Invalid PDF helper header')
    const header = JSON.parse(bytes.subarray(0, newline).toString('utf8'))
    if (!header || typeof header !== 'object' || Object.keys(header).sort().join(',') !== 'height,page,pageCount,pageHeight,pageWidth,width') throw new Error('Invalid PDF helper metadata')
    const { page, pageCount, width, height, pageWidth, pageHeight } = header
    if (![page, pageCount, width, height].every(Number.isSafeInteger) || page < 1 || page > pageCount || pageCount > 10000 || width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8000000 || ![pageWidth, pageHeight].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid PDF helper dimensions')
    const png = bytes.subarray(newline + 1)
    if (png.length < 33 || png.length > 8 * 1024 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) throw new Error('Invalid PDF helper PNG')
    return { header, png }
}

export async function invokePdfHelper(binary, bytes, args = ['1', '1']) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] })
        const chunks = []
        let length = 0, stderr = '', failure
        const fail = message => { failure ??= new Error(message); child.kill('SIGKILL') }
        const timer = setTimeout(() => fail('PDF helper timed out'), 8000)
        child.once('error', error => { failure ??= error })
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') fail('PDF helper input failed') })
        child.stdout.on('data', chunk => {
            length += chunk.length
            if (length > 8 * 1024 * 1024 + 512) fail('PDF helper exceeded output limit')
            else chunks.push(chunk)
        })
        child.stderr.on('data', chunk => {
            if (stderr.length + chunk.length > 256) fail('PDF helper exceeded error limit')
            else stderr += chunk.toString('utf8')
        })
        child.once('close', (code, signal) => {
            clearTimeout(timer)
            if (failure) reject(failure)
            else resolve({ code, signal, stdout: Buffer.concat(chunks), stderr })
        })
        child.stdin.end(bytes)
    })
}

export async function verifyPdfHelper(binary) {
    const result = await invokePdfHelper(binary, pdfFixture())
    if (result.code !== 0 || result.stderr) throw new Error('Packaged PDF helper could not render')
    const { header } = parsePdfRender(result.stdout)
    if (header.page !== 1 || header.pageCount !== 1 || header.pageWidth !== 72 || header.pageHeight !== 96 || header.width !== 144 || header.height !== 192) throw new Error('Packaged PDF helper returned unexpected page geometry')
    return header
}
