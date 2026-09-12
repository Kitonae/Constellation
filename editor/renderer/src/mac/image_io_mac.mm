// ImageIO implementation of the image seam.
//
// Decoding goes through vImage rather than a CGBitmapContext: 8-bit CG
// contexts refuse non-premultiplied alpha, and the blend state expects
// straight alpha, the same as WIC's 32bppRGBA on Windows.

#include "image_io.h"

#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Accelerate/Accelerate.h>
#include <cstdio>
#include <cstring>

namespace {

bool imageToRGBA(CGImageRef image, std::vector<uint8_t>& rgba, uint32_t& width, uint32_t& height) {
    if (!image) return false;
    const size_t w = CGImageGetWidth(image), h = CGImageGetHeight(image);
    if (w == 0 || h == 0) return false;

    CGColorSpaceRef srgb = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    vImage_CGImageFormat fmt = {};
    fmt.bitsPerComponent = 8;
    fmt.bitsPerPixel = 32;
    fmt.colorSpace = srgb;
    fmt.bitmapInfo = (CGBitmapInfo)kCGImageAlphaLast | (CGBitmapInfo)kCGBitmapByteOrder32Big;   // R,G,B,A in memory, straight alpha
    fmt.renderingIntent = kCGRenderingIntentDefault;

    vImage_Buffer buf = {};
    vImage_Error err = vImageBuffer_InitWithCGImage(&buf, &fmt, nullptr, image, kvImageNoFlags);
    CGColorSpaceRelease(srgb);
    if (err != kvImageNoError || !buf.data) {
        fprintf(stderr, "[ImageIO] vImage conversion failed: %ld\n", (long)err);
        return false;
    }

    rgba.resize(w * h * 4);
    for (size_t y = 0; y < h; y++) {
        memcpy(rgba.data() + y * w * 4, (const uint8_t*)buf.data + y * buf.rowBytes, w * 4);
    }
    free(buf.data);
    width = (uint32_t)w;
    height = (uint32_t)h;
    return true;
}

bool sourceToRGBA(CGImageSourceRef src, std::vector<uint8_t>& rgba, uint32_t& width, uint32_t& height) {
    if (!src) return false;
    NSDictionary* opts = @{ (id)kCGImageSourceShouldCache: @NO };
    CGImageRef image = CGImageSourceCreateImageAtIndex(src, 0, (__bridge CFDictionaryRef)opts);
    bool ok = imageToRGBA(image, rgba, width, height);
    if (image) CGImageRelease(image);
    return ok;
}

} // namespace

bool decodeImageFileRGBA(const std::string& path, std::vector<uint8_t>& rgba,
                         uint32_t& width, uint32_t& height) {
    @autoreleasepool {
        NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]];
        CGImageSourceRef src = CGImageSourceCreateWithURL((__bridge CFURLRef)url, nullptr);
        if (!src) {
            fprintf(stderr, "[ImageIO] Cannot open %s\n", path.c_str());
            return false;
        }
        bool ok = sourceToRGBA(src, rgba, width, height);
        CFRelease(src);
        return ok;
    }
}

bool decodeImageBytesRGBA(const uint8_t* data, size_t size, std::vector<uint8_t>& rgba,
                          uint32_t& width, uint32_t& height) {
    if (!data || size == 0) return false;
    @autoreleasepool {
        CFDataRef cfdata = CFDataCreate(kCFAllocatorDefault, data, (CFIndex)size);
        CGImageSourceRef src = CGImageSourceCreateWithData(cfdata, nullptr);
        bool ok = sourceToRGBA(src, rgba, width, height);
        if (src) CFRelease(src);
        CFRelease(cfdata);
        return ok;
    }
}

bool writePngBGRA(const std::string& path, const std::vector<uint8_t>& bgra,
                  uint32_t width, uint32_t height) {
    if (bgra.size() < (size_t)width * height * 4) return false;
    @autoreleasepool {
        CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
        CGDataProviderRef provider = CGDataProviderCreateWithData(nullptr, bgra.data(), bgra.size(), nullptr);
        // Memory order B,G,R,A read as a little-endian 32-bit word is ARGB,
        // which CG calls "alpha first, 32-bit little endian".
        CGImageRef image = CGImageCreate(width, height, 8, 32, (size_t)width * 4, cs,
            (CGBitmapInfo)kCGBitmapByteOrder32Little | (CGBitmapInfo)kCGImageAlphaNoneSkipFirst,
            provider, nullptr, false, kCGRenderingIntentDefault);
        CGDataProviderRelease(provider);
        CGColorSpaceRelease(cs);
        if (!image) return false;

        NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]];
        CGImageDestinationRef dest = CGImageDestinationCreateWithURL((__bridge CFURLRef)url,
            CFSTR("public.png"), 1, nullptr);
        bool ok = false;
        if (dest) {
            CGImageDestinationAddImage(dest, image, nullptr);
            ok = CGImageDestinationFinalize(dest);
            CFRelease(dest);
        }
        CGImageRelease(image);
        return ok;
    }
}
