// PDF bytes for root's native text-helper check and packaged runtime probe.
// Glyph positions are whatever PDFKit reports; the geometry below is
// the crop and rotation the helper must echo.

function pdfTextFixture(pages) {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '']
    const kids = []
    for (const page of pages) {
        const width = page.width ?? 612
        const height = page.height ?? 792
        const rotation = page.rotation ?? 0
        const id = objects.length + 1
        kids.push(`${id} 0 R`)
        let stream
        let resources = '<< >>'
        if (typeof page.text === 'string') {
            const escaped = page.text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
            stream = `BT /F1 18 Tf 72 72 Td (${escaped}) Tj ET\n`
            resources = '<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >>'
        } else {
            stream = `0 0 0 rg\n0 0 ${width} ${height} re f\n`
        }
        const crop = page.crop ? ` /CropBox [${page.crop.x} ${page.crop.y} ${page.crop.x + page.crop.width} ${page.crop.y + page.crop.height}]` : ''
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]${crop} /Rotate ${rotation} /Resources ${resources} /Contents ${id + 1} 0 R >>`)
        objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`)
    }
    objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(' ')}] >>`
    let pdf = '%PDF-1.4\n'
    const offsets = [0]
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
    const xref = Buffer.byteLength(pdf)
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(pdf)
}

export const uprightTextExpectation = { page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792, text: 'Alpha one' }
export const rotatedCroppedExpectation = { page: 1, rotation: 90, crop: { x: 36, y: 36, width: 540, height: 720 }, pageWidth: 720, pageHeight: 540, text: 'Alpha two' }
export const scannedExpectation = { page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792, text: '' }

export const uprightTextPdf = () => pdfTextFixture([{ width: 612, height: 792, text: 'Alpha one' }])
export const rotatedCroppedPdf = () => pdfTextFixture([{ width: 612, height: 792, rotation: 90, crop: { x: 36, y: 36, width: 540, height: 720 }, text: 'Alpha two' }])
export const scannedPdf = () => pdfTextFixture([{ width: 612, height: 792, text: null }])
export const mixedPdf = () => pdfTextFixture([
    { width: 612, height: 792, text: 'Alpha one' },
    { width: 612, height: 792, rotation: 90, crop: { x: 36, y: 36, width: 540, height: 720 }, text: 'Alpha two' },
    { width: 612, height: 792, text: null },
])
