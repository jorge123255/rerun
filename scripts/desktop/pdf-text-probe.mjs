import { invokePdfHelper } from './pdf-helper-probe.mjs'
import { mixedPdf, uprightTextExpectation, rotatedCroppedExpectation, scannedExpectation } from './pdf-text-fixture.mjs'

/** Packaged helper acceptance. It receives bytes on stdin and no document path. */
export async function verifyPdfTextHelper(binary) {
    const result = await invokePdfHelper(binary, mixedPdf(), [])
    if (result.code !== 0 || result.stderr || result.stdout.length > 2 * 1024 * 1024) throw new Error('Packaged PDF text helper could not extract')
    const body = JSON.parse(result.stdout.toString('utf8'))
    if (body.pageCount !== 3 || body.truncated !== false || body.reason !== '' || body.pages?.length !== 3) throw new Error('Invalid PDF text document')
    for (const [index, expected] of [uprightTextExpectation, rotatedCroppedExpectation, scannedExpectation].entries()) {
        const page = body.pages[index]
        if (page.page !== index + 1 || page.rotation !== expected.rotation || page.pageWidth !== expected.pageWidth || page.pageHeight !== expected.pageHeight ||
            Object.entries(expected.crop).some(([key, value]) => page.crop?.[key] !== value) || page.text.trim() !== expected.text || !Array.isArray(page.runs)) throw new Error('Invalid PDF text page geometry')
        if (expected.text ? page.runs.length === 0 : page.runs.length !== 0) throw new Error('Invalid PDF text runs')
        for (const run of page.runs) {
            if (![run.x, run.y, run.w, run.h].every(Number.isFinite) || run.x < 0 || run.y < 0 || run.w <= 0 || run.h <= 0 || run.x + run.w > 1.0001 || run.y + run.h > 1.0001 || !Number.isInteger(run.start) || !Number.isInteger(run.end) || run.start < 0 || run.end <= run.start || run.end > page.text.length) throw new Error('Invalid PDF text run geometry')
        }
    }
    return body
}
