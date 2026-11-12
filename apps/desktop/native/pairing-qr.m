#import <AppKit/AppKit.h>
#import <CoreImage/CoreImage.h>
#include <stdio.h>

int main(void) {
    @autoreleasepool {
        unsigned char input[2049];
        const size_t length = fread(input, 1, sizeof(input), stdin);
        if (ferror(stdin) || length == 0 || length == sizeof(input)) return 1;

        CIFilter *filter = [CIFilter filterWithName:@"CIQRCodeGenerator"];
        [filter setValue:[NSData dataWithBytes:input length:length] forKey:@"inputMessage"];
        [filter setValue:@"M" forKey:@"inputCorrectionLevel"];
        CIImage *code = filter.outputImage;
        if (!code || CGRectIsEmpty(code.extent)) return 1;

        CGImageRef bitmap = [[CIContext contextWithOptions:nil] createCGImage:code fromRect:code.extent];
        if (!bitmap) return 1;
        NSBitmapImageRep *image = [[NSBitmapImageRep alloc] initWithCGImage:bitmap];
        CGImageRelease(bitmap);
        NSData *png = [image representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        return png.length > 0 && fwrite(png.bytes, 1, png.length, stdout) == png.length ? 0 : 1;
    }
}
