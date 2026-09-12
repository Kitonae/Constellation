#pragma once

#include <mfobjects.h>
#include <cstdint>
#include <vector>

// Copy RGB32 into tightly packed, top-down BGRA with opaque alpha.
// defaultStride describes buffers which do not expose IMF2DBuffer.
bool copyVideoBuffer(IMFMediaBuffer* buffer, uint32_t width, uint32_t height,
                     LONG defaultStride, std::vector<uint8_t>& pixels);
