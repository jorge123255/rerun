// Extract positioned text from one PDF on stdin. This process never opens a
// document by path, never rasterizes a page, and never sends bytes anywhere
// except the JSON document on stdout. Coordinates are normalized to the same
// crop box and rotation CGPDFPageGetDrawingTransform uses for the PNG page,
// with the origin at the top-left of that displayed box. A page with no text
// is an empty string, not an OCR result.
#include <CoreGraphics/CoreGraphics.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#import <Foundation/Foundation.h>
#import <PDFKit/PDFKit.h>

#define PDF_MAX_INPUT (16U * 1024U * 1024U)
#define PDF_MAX_OUTPUT (2U * 1024U * 1024U)
#define PDF_MAX_PAGES 10000U
#define PDF_MAX_CHARS 500000U
#define PDF_MAX_RUNS 8000U
#define PDF_MAX_PAGE_CHARS 100000U
#define PDF_MAX_PAGE_RUNS 2000U

static void *watch_parent(void *value) {
    pid_t parent = (pid_t)(intptr_t)value;
    const struct timespec interval = {.tv_sec = 0, .tv_nsec = 100000000};
    for (;;) {
        if (getppid() != parent) _exit(1);
        (void)nanosleep(&interval, NULL);
    }
    return NULL;
}

static bool write_all(int fd, const void *bytes, size_t count) {
    const unsigned char *next = bytes;
    while (count) {
        ssize_t written = write(fd, next, count);
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return false;
        next += written;
        count -= (size_t)written;
    }
    return true;
}

static bool pdf_whitespace(unsigned char value) {
    return value == 0 || value == 9 || value == 10 || value == 12 || value == 13 || value == 32;
}

static bool envelope(const unsigned char *bytes, size_t length) {
    if (length < 14 || memcmp(bytes, "%PDF-", 5) != 0) return false;
    while (length && pdf_whitespace(bytes[length - 1])) length--;
    return length >= 5 && memcmp(bytes + length - 5, "%%EOF", 5) == 0;
}

static bool same_baseline(CGRect line, CGRect glyph) {
    double height = fmax(line.size.height, glyph.size.height);
    if (!(height > 0)) return false;
    if (fabs(CGRectGetMidY(line) - CGRectGetMidY(glyph)) > height * 0.5) return false;
    double gap = CGRectGetMinX(glyph) - CGRectGetMaxX(line);
    return gap >= -height * 0.25 && gap <= height * 2.0;
}

// characterBoundsAtIndex is taken as unrotated PDF user space, the same space
// as CGPDFPageGetBoxRect. This drawing transform is the only rotation and crop
// mapping; PDFPage transformForBox would rotate the boxes a second time.
static bool displayed_box(CGRect bounds, CGAffineTransform transform, double pageWidth, double pageHeight, double *x, double *y, double *w, double *h) {
    if (!isfinite(bounds.origin.x) || !isfinite(bounds.origin.y) || !isfinite(bounds.size.width) || !isfinite(bounds.size.height)) return false;
    if (bounds.size.width < 0) { bounds.origin.x += bounds.size.width; bounds.size.width = -bounds.size.width; }
    if (bounds.size.height < 0) { bounds.origin.y += bounds.size.height; bounds.size.height = -bounds.size.height; }
    if (!(bounds.size.width > 0) || !(bounds.size.height > 0) || !(pageWidth > 0) || !(pageHeight > 0)) return false;
    CGPoint corners[4] = {
        CGPointApplyAffineTransform(CGPointMake(CGRectGetMinX(bounds), CGRectGetMinY(bounds)), transform),
        CGPointApplyAffineTransform(CGPointMake(CGRectGetMaxX(bounds), CGRectGetMinY(bounds)), transform),
        CGPointApplyAffineTransform(CGPointMake(CGRectGetMinX(bounds), CGRectGetMaxY(bounds)), transform),
        CGPointApplyAffineTransform(CGPointMake(CGRectGetMaxX(bounds), CGRectGetMaxY(bounds)), transform),
    };
    double minX = INFINITY, minY = INFINITY, maxX = -INFINITY, maxY = -INFINITY;
    for (int i = 0; i < 4; i++) {
        if (!isfinite(corners[i].x) || !isfinite(corners[i].y)) return false;
        minX = fmin(minX, corners[i].x); maxX = fmax(maxX, corners[i].x);
        minY = fmin(minY, corners[i].y); maxY = fmax(maxY, corners[i].y);
    }
    double left = minX / pageWidth, right = maxX / pageWidth;
    double top = 1.0 - (maxY / pageHeight), bottom = 1.0 - (minY / pageHeight);
    double x0 = fmax(0, fmin(1, fmin(left, right)));
    double x1 = fmax(0, fmin(1, fmax(left, right)));
    double y0 = fmax(0, fmin(1, fmin(top, bottom)));
    double y1 = fmax(0, fmin(1, fmax(top, bottom)));
    if (x1 - x0 < 0.0005 || y1 - y0 < 0.0005) return false;
    *x = x0; *y = y0; *w = x1 - x0; *h = y1 - y0;
    return true;
}

static NSDictionary *run_json(CGRect bounds, CGAffineTransform transform, double pageWidth, double pageHeight, NSUInteger start, NSUInteger end) {
    double x = 0, y = 0, w = 0, h = 0;
    if (!displayed_box(bounds, transform, pageWidth, pageHeight, &x, &y, &w, &h)) return nil;
    return @{ @"start": @(start), @"end": @(end), @"x": @(x), @"y": @(y), @"w": @(w), @"h": @(h) };
}

// Returns the page object, or nil when the page geometry cannot be aligned.
// *stop is set when a text or run cap is reached. The partial page is kept.
static NSDictionary *extract_page(PDFPage *pdfPage, CGPDFDocumentRef cgDocument, NSUInteger index, NSUInteger *chars, NSUInteger *runs, BOOL *stop, int *reason) {
    CGPDFPageRef cgPage = pdfPage.pageRef;
    if (!cgPage || CGPDFPageGetDocument(cgPage) != cgDocument) return nil;
    CGRect crop = CGPDFPageGetBoxRect(cgPage, kCGPDFCropBox);
    int rotation = (int)CGPDFPageGetRotationAngle(cgPage);
    rotation %= 360;
    if (rotation < 0) rotation += 360;
    if (rotation % 90 != 0 || !isfinite(crop.origin.x) || !isfinite(crop.origin.y) || !isfinite(crop.size.width) || !isfinite(crop.size.height) || !(crop.size.width > 0) || !(crop.size.height > 0)) return nil;
    BOOL sideways = rotation % 180 != 0;
    double pageWidth = sideways ? crop.size.height : crop.size.width;
    double pageHeight = sideways ? crop.size.width : crop.size.height;
    CGAffineTransform transform = CGPDFPageGetDrawingTransform(cgPage, kCGPDFCropBox, CGRectMake(0, 0, pageWidth, pageHeight), 0, true);
    if (!isfinite(transform.a) || !isfinite(transform.b) || !isfinite(transform.c) || !isfinite(transform.d) || !isfinite(transform.tx) || !isfinite(transform.ty)) return nil;

    NSString *source = pdfPage.string ?: @"";
    NSUInteger count = pdfPage.numberOfCharacters;
    if (count == 0) source = @"";
    else if (source.length != count) return nil;
    NSMutableString *text = [NSMutableString string];
    NSMutableArray *pageRuns = [NSMutableArray array];
    BOOL open = NO;
    NSUInteger runStart = 0;
    CGRect runBounds = CGRectNull;
    for (NSUInteger i = 0; i < count; i++) {
        if (*chars + text.length >= PDF_MAX_CHARS || text.length >= PDF_MAX_PAGE_CHARS) { *stop = YES; *reason = 1; break; }
        unichar character = [source characterAtIndex:i];
        NSUInteger advance = 1;
        if (character >= 0xD800 && character <= 0xDBFF && i + 1 < count) {
            unichar low = [source characterAtIndex:i + 1];
            if (low >= 0xDC00 && low <= 0xDFFF) advance = 2;
        }
        if (character == '\r') continue;
        if (character == '\n' || character == '\t' || character == ' ') {
            if (open) {
                NSDictionary *run = run_json(runBounds, transform, pageWidth, pageHeight, runStart, text.length);
                open = NO;
                if (run) {
                    if (*runs + pageRuns.count >= PDF_MAX_RUNS || pageRuns.count >= PDF_MAX_PAGE_RUNS) { *stop = YES; *reason = 2; break; }
                    [pageRuns addObject:run];
                }
            }
            [text appendString:[source substringWithRange:NSMakeRange(i, 1)]];
            continue;
        }
        if (character < 32) continue;
        NSRect glyph = [pdfPage characterBoundsAtIndex:(NSInteger)i];
        BOOL measurable = isfinite(glyph.origin.x) && isfinite(glyph.origin.y) && isfinite(glyph.size.width) && isfinite(glyph.size.height) && glyph.size.width != 0 && glyph.size.height != 0;
        if (!measurable) {
            if (open) {
                NSDictionary *run = run_json(runBounds, transform, pageWidth, pageHeight, runStart, text.length);
                open = NO;
                if (run) {
                    if (*runs + pageRuns.count >= PDF_MAX_RUNS || pageRuns.count >= PDF_MAX_PAGE_RUNS) { *stop = YES; *reason = 2; break; }
                    [pageRuns addObject:run];
                }
            }
        } else if (open && same_baseline(runBounds, glyph)) {
            runBounds = CGRectUnion(runBounds, glyph);
        } else {
            if (open) {
                NSDictionary *run = run_json(runBounds, transform, pageWidth, pageHeight, runStart, text.length);
                if (run) {
                    if (*runs + pageRuns.count >= PDF_MAX_RUNS || pageRuns.count >= PDF_MAX_PAGE_RUNS) { *stop = YES; *reason = 2; break; }
                    [pageRuns addObject:run];
                }
            }
            open = YES;
            runStart = text.length;
            runBounds = glyph;
        }
        [text appendString:[source substringWithRange:NSMakeRange(i, advance)]];
        i += advance - 1;
    }
    if (open) {
        NSDictionary *run = run_json(runBounds, transform, pageWidth, pageHeight, runStart, text.length);
        if (run && *runs + pageRuns.count < PDF_MAX_RUNS && pageRuns.count < PDF_MAX_PAGE_RUNS) [pageRuns addObject:run];
        else if (run && !*stop) { *stop = YES; *reason = 2; }
    }
    *chars += text.length;
    *runs += pageRuns.count;
    return @{
        @"page": @(index + 1),
        @"rotation": @(rotation),
        @"crop": @{ @"x": @(crop.origin.x), @"y": @(crop.origin.y), @"width": @(crop.size.width), @"height": @(crop.size.height) },
        @"pageWidth": @(pageWidth),
        @"pageHeight": @(pageHeight),
        @"text": text,
        @"runs": pageRuns,
    };
}

static NSString *reason_name(int reason) {
    if (reason == 1) return @"text";
    if (reason == 2) return @"runs";
    if (reason == 3) return @"pages";
    if (reason == 4) return @"output";
    return @"";
}

typedef struct {
    unsigned char *bytes;
    size_t length;
} PdfTextOutput;

static PdfTextOutput pdf_text_none(void) {
    PdfTextOutput none = { NULL, 0 };
    return none;
}

// Copies the JSON out of the autorelease pool. The caller frees bytes.
static PdfTextOutput extract_document(const unsigned char *input, size_t length) {
    @autoreleasepool {
        if (!envelope(input, length)) return pdf_text_none();
        NSData *data = [NSData dataWithBytes:input length:length];
        PDFDocument *document = [[PDFDocument alloc] initWithData:data];
        if (!document || document.pageCount < 1 || document.pageCount > PDF_MAX_PAGES) return pdf_text_none();
        PDFPage *first = [document pageAtIndex:0];
        CGPDFPageRef firstPage = first.pageRef;
        CGPDFDocumentRef cgDocument = firstPage ? CGPDFPageGetDocument(firstPage) : NULL;
        size_t pageCount = cgDocument ? CGPDFDocumentGetNumberOfPages(cgDocument) : 0;
        if (!cgDocument || CGPDFDocumentIsEncrypted(cgDocument) || !CGPDFDocumentIsUnlocked(cgDocument) || pageCount != (size_t)document.pageCount) return pdf_text_none();

        NSMutableArray *pages = [NSMutableArray arrayWithCapacity:pageCount];
        BOOL stop = NO;
        int reason = 0;
        NSUInteger chars = 0, runs = 0;
        for (NSUInteger index = 0; index < pageCount && !stop; index++) {
            if (chars >= PDF_MAX_CHARS || runs >= PDF_MAX_RUNS) { stop = YES; reason = chars >= PDF_MAX_CHARS ? 1 : 2; break; }
            PDFPage *pdfPage = [document pageAtIndex:index];
            if (!pdfPage) return pdf_text_none();
            NSDictionary *page = extract_page(pdfPage, cgDocument, index, &chars, &runs, &stop, &reason);
            if (!page) return pdf_text_none();
            [pages addObject:page];
        }
        if (pages.count == 0) return pdf_text_none();
        NSString *reasonText = reason_name(reason);
        NSData *json = [NSJSONSerialization dataWithJSONObject:@{
            @"pageCount": @(pageCount), @"truncated": stop ? @YES : @NO, @"reason": reasonText, @"pages": pages,
        } options:0 error:NULL];
        while ((!json || json.length + 1 > PDF_MAX_OUTPUT) && pages.count > 1) {
            [pages removeLastObject];
            stop = YES;
            reasonText = @"output";
            json = [NSJSONSerialization dataWithJSONObject:@{
                @"pageCount": @(pageCount), @"truncated": @YES, @"reason": reasonText, @"pages": pages,
            } options:0 error:NULL];
        }
        if (!json || json.length + 1 > PDF_MAX_OUTPUT) return pdf_text_none();
        size_t bytes = json.length + 1;
        unsigned char *copy = malloc(bytes);
        if (!copy) return pdf_text_none();
        memcpy(copy, json.bytes, json.length);
        copy[json.length] = '\n';
        PdfTextOutput output = { copy, bytes };
        return output;
    }
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (signal(SIGALRM, SIG_DFL) == SIG_ERR) return 1;
        sigset_t alarm_signals;
        sigemptyset(&alarm_signals);
        sigaddset(&alarm_signals, SIGALRM);
        if (sigprocmask(SIG_UNBLOCK, &alarm_signals, NULL) != 0) return 1;
        alarm(10);
        int saved = dup(STDERR_FILENO);
        int null_fd = open("/dev/null", O_WRONLY);
        if (saved < 0 || null_fd < 0 || dup2(null_fd, STDERR_FILENO) < 0) {
            if (null_fd >= 0) close(null_fd);
            if (saved >= 0) close(saved);
            return 1;
        }
        close(null_fd);
        unsigned char *input = NULL;
        PdfTextOutput output = { NULL, 0 };
        size_t length = 0;
        int result = 1;
        pid_t parent = getppid();
        pthread_t watcher;
        if (parent <= 1 || pthread_create(&watcher, NULL, watch_parent, (void *)(intptr_t)parent) != 0) goto done;
        if (pthread_detach(watcher) != 0) goto done;
        if (argc != 1) goto done;
        (void)argv;
        input = malloc(PDF_MAX_INPUT + 1);
        if (!input) goto done;
        while (length <= PDF_MAX_INPUT) {
            ssize_t count = read(STDIN_FILENO, input + length, PDF_MAX_INPUT + 1 - length);
            if (count < 0 && errno == EINTR) continue;
            if (count < 0) goto done;
            if (count == 0) break;
            length += (size_t)count;
        }
        if (length > PDF_MAX_INPUT) goto done;
        output = extract_document(input, length);
        if (output.bytes && write_all(STDOUT_FILENO, output.bytes, output.length)) result = 0;
    done:
        free(output.bytes);
        free(input);
        if (result) (void)write_all(saved, "Cannot read PDF text.\n", 22);
        close(saved);
        return result;
    }
}
