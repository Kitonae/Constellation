#include "test_helpers_mac.h"
#include "video_buffer.h"

#import <Metal/Metal.h>
#include <CoreVideo/CoreVideo.h>
#include <cstring>

ObjcRef testMakeSharedEvent() {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) return {};
    id<MTLSharedEvent> event = [device newSharedEvent];
    return event ? retainObjc(event) : ObjcRef{};
}

void testSignalSharedEvent(const ObjcRef& event, uint64_t value) {
    objc<id<MTLSharedEvent>>(event).signaledValue = value;
}

static CVPixelBufferRef makeBuffer(uint32_t width, uint32_t height) {
    NSDictionary* attrs = @{ (id)kCVPixelBufferBytesPerRowAlignmentKey: @64 };
    CVPixelBufferRef pb = nullptr;
    if (CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                            (__bridge CFDictionaryRef)attrs, &pb) != kCVReturnSuccess) return nullptr;
    CVPixelBufferLockBaseAddress(pb, 0);
    uint8_t* base = (uint8_t*)CVPixelBufferGetBaseAddress(pb);
    size_t pitch = CVPixelBufferGetBytesPerRow(pb);
    for (uint32_t y = 0; y < height; y++) memset(base + y * pitch, (int)(y + 1), width * 4);
    CVPixelBufferUnlockBaseAddress(pb, 0);
    return pb;
}

bool testCopyPaddedPixelBuffer(uint32_t width, uint32_t height, std::vector<uint8_t>& pixels) {
    CVPixelBufferRef pb = makeBuffer(width, height);
    if (!pb) return false;
    // The fixture must actually exercise padded rows.
    bool padded = CVPixelBufferGetBytesPerRow(pb) > (size_t)width * 4;
    bool ok = padded && copyPixelBufferBGRA(pb, width, height, pixels);
    CVPixelBufferRelease(pb);
    return ok;
}

bool testCopyMismatchedPixelBuffer(uint32_t width, uint32_t height) {
    CVPixelBufferRef pb = makeBuffer(width, height);
    if (!pb) return true;   // nothing to copy from: vacuously refused
    std::vector<uint8_t> pixels;
    bool ok = copyPixelBufferBGRA(pb, width + 1, height, pixels);
    CVPixelBufferRelease(pb);
    return ok;
}
