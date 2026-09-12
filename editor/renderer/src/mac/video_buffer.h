#pragma once

#include <CoreVideo/CoreVideo.h>
#include <cstdint>
#include <vector>

// Copy a 32BGRA CVPixelBuffer into tightly packed, top-down BGRA with opaque
// alpha. The buffer's own bytesPerRow is honoured, which is usually wider
// than width*4. Returns false if the buffer is not the size asked for.
bool copyPixelBufferBGRA(CVPixelBufferRef buffer, uint32_t width, uint32_t height,
                         std::vector<uint8_t>& pixels);
