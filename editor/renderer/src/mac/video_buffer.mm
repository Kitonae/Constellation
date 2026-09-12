#include "video_buffer.h"
#include <cstring>

bool copyPixelBufferBGRA(CVPixelBufferRef buffer, uint32_t width, uint32_t height,
                         std::vector<uint8_t>& pixels) {
    if (!buffer) return false;
    if (CVPixelBufferGetWidth(buffer) != width || CVPixelBufferGetHeight(buffer) != height) return false;
    if (CVPixelBufferGetPixelFormatType(buffer) != kCVPixelFormatType_32BGRA) return false;
    if (CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) return false;

    const uint8_t* base = (const uint8_t*)CVPixelBufferGetBaseAddress(buffer);
    const size_t pitch = CVPixelBufferGetBytesPerRow(buffer);
    const size_t rowBytes = (size_t)width * 4;
    bool ok = base != nullptr && pitch >= rowBytes;
    if (ok) {
        pixels.resize(rowBytes * height);
        for (uint32_t y = 0; y < height; y++) {
            memcpy(pixels.data() + (size_t)y * rowBytes, base + (size_t)y * pitch, rowBytes);
        }
        // Force alpha opaque, as the Windows readback path does.
        uint32_t* px = (uint32_t*)pixels.data();
        const size_t count = (size_t)width * height;
        for (size_t i = 0; i < count; i++) px[i] |= 0xFF000000u;
    }
    CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly);
    return ok;
}
