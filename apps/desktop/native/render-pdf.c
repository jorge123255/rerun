// Render one page from stdin. This process never opens a document by path and
// uses only CoreGraphics drawing, not a browser, PDF plug-in, or script engine.
// The caller supplies a wall-clock deadline and kills/reaps this process on
// timeout or cancellation. Bitmap/input/output caps are not an OS memory quota.
#include <CoreFoundation/CoreFoundation.h>
#include <CoreGraphics/CoreGraphics.h>
#include <ImageIO/ImageIO.h>
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

#define PDF_MAX_INPUT (16U * 1024U * 1024U)
#define PDF_MAX_OUTPUT (8U * 1024U * 1024U)
#define PDF_MAX_PIXELS 8000000U
#define PDF_MAX_DIMENSION 4096U
#define PDF_MAX_PAGES 10000U

static void *watch_parent(void *value) {
    pid_t parent = (pid_t)(intptr_t)value;
    const struct timespec interval = {.tv_sec = 0, .tv_nsec = 100000000};
    for (;;) {
        if (getppid() != parent) _exit(1);
        (void)nanosleep(&interval, NULL);
    }
    return NULL;
}

typedef struct {
    unsigned char *bytes;
    size_t length;
    bool failed;
} Output;

static size_t consume(void *info, const void *bytes, size_t count) {
    Output *out = info;
    if (out->failed || count > PDF_MAX_OUTPUT - out->length) {
        out->failed = true;
        return 0;
    }
    memcpy(out->bytes + out->length, bytes, count);
    out->length += count;
    return count;
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

int main(int argc, char **argv) {
    // Remain bounded even if the supervising UI service dies and loses its
    // deadline timer. SIGALRM terminates the entire process, including decode.
    if (signal(SIGALRM, SIG_DFL) == SIG_ERR) return 1;
    sigset_t alarm_signals;
    sigemptyset(&alarm_signals);
    sigaddset(&alarm_signals, SIGALRM);
    if (sigprocmask(SIG_UNBLOCK, &alarm_signals, NULL) != 0) return 1;
    alarm(10);
    int result = 1;
    // CoreGraphics may print parser diagnostics containing document fragments.
    // Silence framework diagnostics; expose only our constant error message.
    int errors = dup(STDERR_FILENO);
    int null_fd = open("/dev/null", O_WRONLY);
    if (errors < 0 || null_fd < 0 || dup2(null_fd, STDERR_FILENO) < 0) {
        if (null_fd >= 0) close(null_fd);
        if (errors >= 0) close(errors);
        return 1;
    }
    close(null_fd);
    unsigned char *input = NULL;
    Output output = {0};
    CFDataRef data = NULL;
    CGDataProviderRef provider = NULL;
    CGPDFDocumentRef document = NULL;
    CGPDFContentStreamRef content = NULL;
    CGPDFOperatorTableRef operators = NULL;
    CGPDFScannerRef scanner = NULL;
    CGColorSpaceRef colors = NULL;
    CGContextRef bitmap = NULL;
    CGImageRef image = NULL;
    CGDataConsumerRef consumer = NULL;
    CGImageDestinationRef destination = NULL;

    pid_t parent = getppid();
    pthread_t watcher;
    if (parent <= 1 || pthread_create(&watcher, NULL, watch_parent, (void *)(intptr_t)parent) != 0) goto cleanup;
    if (pthread_detach(watcher) != 0) goto cleanup;

    if (argc < 2 || argc > 3 || !argv[1][0]) goto cleanup;
    for (const char *c = argv[1]; *c; c++) if (*c < '0' || *c > '9') goto cleanup;
    errno = 0;
    char *end = NULL;
    unsigned long page_number = strtoul(argv[1], &end, 10);
    if (errno || !end || *end || page_number < 1 || page_number > PDF_MAX_PAGES) goto cleanup;
    double scale = 1.5;
    if (argc == 3) {
        errno = 0;
        scale = strtod(argv[2], &end);
        if (errno || !argv[2][0] || !end || *end || !isfinite(scale) || scale < .25 || scale > 3) goto cleanup;
    }
    input = malloc(PDF_MAX_INPUT + 1);
    if (!input) goto cleanup;
    size_t length = 0;
    while (length <= PDF_MAX_INPUT) {
        ssize_t count = read(STDIN_FILENO, input + length, PDF_MAX_INPUT + 1 - length);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) goto cleanup;
        if (count == 0) break;
        length += (size_t)count;
    }
    if (length > PDF_MAX_INPUT || !envelope(input, length)) goto cleanup;
    data = CFDataCreateWithBytesNoCopy(kCFAllocatorDefault, input, (CFIndex)length, kCFAllocatorNull);
    if (!data) goto cleanup;
    provider = CGDataProviderCreateWithCFData(data);
    if (!provider) goto cleanup;
    document = CGPDFDocumentCreateWithProvider(provider);
    if (!document || CGPDFDocumentIsEncrypted(document) || !CGPDFDocumentIsUnlocked(document) || !CGPDFDocumentGetCatalog(document)) goto cleanup;
    size_t page_count = CGPDFDocumentGetNumberOfPages(document);
    if (page_count < 1 || page_count > PDF_MAX_PAGES || page_number > page_count) goto cleanup;
    CGPDFPageRef page = CGPDFDocumentGetPage(document, page_number);
    if (!page) goto cleanup;
    content = CGPDFContentStreamCreateWithPage(page);
    operators = CGPDFOperatorTableCreate();
    if (!content || !operators) goto cleanup;
    scanner = CGPDFScannerCreate(content, operators, NULL);
    if (!scanner || !CGPDFScannerScan(scanner)) goto cleanup;
    CGRect box = CGPDFPageGetBoxRect(page, kCGPDFCropBox);
    int rotation = CGPDFPageGetRotationAngle(page);
    if (rotation % 90 != 0 || !isfinite(box.origin.x) || !isfinite(box.origin.y) || !isfinite(box.size.width) || !isfinite(box.size.height) || box.size.width <= 0 || box.size.height <= 0) goto cleanup;
    bool sideways = rotation % 180 != 0;
    double page_width = sideways ? box.size.height : box.size.width;
    double page_height = sideways ? box.size.width : box.size.height;
    // Apply dimension limits before multiplying, including on arm64 where
    // long double has the same range as double.
    long double fit = fminl(scale * 2, fminl(PDF_MAX_DIMENSION / (long double)page_width, PDF_MAX_DIMENSION / (long double)page_height));
    long double fitted_area = (page_width * fit) * (page_height * fit);
    if (fitted_area > PDF_MAX_PIXELS) fit *= sqrtl(PDF_MAX_PIXELS / fitted_area);
    size_t width = (size_t)fmaxl(1, floorl(page_width * fit));
    size_t height = (size_t)fmaxl(1, floorl(page_height * fit));
    if (!width || !height || width > PDF_MAX_DIMENSION || height > PDF_MAX_DIMENSION || width * height > PDF_MAX_PIXELS) goto cleanup;
    colors = CGColorSpaceCreateDeviceRGB();
    if (!colors) goto cleanup;
    bitmap = CGBitmapContextCreate(NULL, width, height, 8, width * 4, colors, kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
    if (!bitmap) goto cleanup;
    CGContextSetRGBFillColor(bitmap, 1, 1, 1, 1);
    CGContextFillRect(bitmap, CGRectMake(0, 0, width, height));
    CGAffineTransform transform = CGPDFPageGetDrawingTransform(page, kCGPDFCropBox, CGRectMake(0, 0, width, height), 0, true);
    if (!isfinite(transform.a) || !isfinite(transform.b) || !isfinite(transform.c) || !isfinite(transform.d) || !isfinite(transform.tx) || !isfinite(transform.ty)) goto cleanup;
    CGContextConcatCTM(bitmap, transform);
    CGContextDrawPDFPage(bitmap, page);
    image = CGBitmapContextCreateImage(bitmap);
    if (!image) goto cleanup;
    output.bytes = malloc(PDF_MAX_OUTPUT);
    if (!output.bytes) goto cleanup;
    const CGDataConsumerCallbacks callbacks = {consume, NULL};
    consumer = CGDataConsumerCreate(&output, &callbacks);
    if (!consumer) goto cleanup;
    destination = CGImageDestinationCreateWithDataConsumer(consumer, CFSTR("public.png"), 1, NULL);
    if (!destination) goto cleanup;
    CGImageDestinationAddImage(destination, image, NULL);
    if (!CGImageDestinationFinalize(destination) || output.failed || output.length < 8 || output.length > PDF_MAX_OUTPUT) goto cleanup;
    char header[512];
    int header_length = snprintf(header, sizeof header, "{\"page\":%lu,\"pageCount\":%zu,\"width\":%zu,\"height\":%zu,\"pageWidth\":%.17g,\"pageHeight\":%.17g}\n", page_number, page_count, width, height, page_width, page_height);
    if (header_length < 0 || (size_t)header_length >= sizeof header || !write_all(STDOUT_FILENO, header, (size_t)header_length) || !write_all(STDOUT_FILENO, output.bytes, output.length)) goto cleanup;
    result = 0;
cleanup:
    if (destination) CFRelease(destination);
    if (consumer) CGDataConsumerRelease(consumer);
    if (image) CGImageRelease(image);
    if (bitmap) CGContextRelease(bitmap);
    if (colors) CGColorSpaceRelease(colors);
    if (scanner) CGPDFScannerRelease(scanner);
    if (operators) CGPDFOperatorTableRelease(operators);
    if (content) CGPDFContentStreamRelease(content);
    if (document) CGPDFDocumentRelease(document);
    if (provider) CGDataProviderRelease(provider);
    if (data) CFRelease(data);
    free(input);
    free(output.bytes);
    if (result) (void)write_all(errors, "Cannot render PDF page.\n", 24);
    close(errors);
    return result;
}
