#include "video_buffer.h"
#include <wrl/client.h>
#include <cstddef>
#include <cstring>
#include <limits>

bool copyVideoBuffer(IMFMediaBuffer* buffer, uint32_t width, uint32_t height,
                     LONG defaultStride, std::vector<uint8_t>& pixels) {
    if (!buffer || !width || !height) return false;
    const size_t rowBytes = static_cast<size_t>(width) * 4;
    if (rowBytes > static_cast<size_t>((std::numeric_limits<LONG>::max)()) ||
        height > (std::numeric_limits<size_t>::max)() / rowBytes) return false;

    Microsoft::WRL::ComPtr<IMF2DBuffer> buffer2d;
    BYTE* scanline = nullptr;
    LONG stride = defaultStride ? defaultStride : static_cast<LONG>(rowBytes);
    DWORD length = 0;
    const bool is2d = SUCCEEDED(buffer->QueryInterface(IID_PPV_ARGS(&buffer2d)));
    HRESULT hr = is2d ? buffer2d->Lock2D(&scanline, &stride)
                      : buffer->Lock(&scanline, nullptr, &length);
    if (FAILED(hr)) return false;

    const auto unlock = [&] { if (is2d) buffer2d->Unlock2D(); else buffer->Unlock(); };
    const int64_t pitch = stride < 0 ? -static_cast<int64_t>(stride) : stride;
    const uint64_t required = static_cast<uint64_t>(height - 1) * pitch + rowBytes;
    if (!scanline || pitch < static_cast<int64_t>(rowBytes) ||
        required > static_cast<uint64_t>((std::numeric_limits<ptrdiff_t>::max)()) ||
        (!is2d && required > length)) {
        unlock();
        return false;
    }
    // Lock2D already points at the top scanline, even for negative pitch.
    // A plain Lock points at the beginning of the allocation instead.
    if (!is2d && stride < 0) scanline += static_cast<ptrdiff_t>(height - 1) * pitch;
    try {
        pixels.resize(rowBytes * height);
    } catch (...) {
        unlock();
        throw;
    }
    for (uint32_t y = 0; y < height; ++y) {
        memcpy(pixels.data() + static_cast<size_t>(y) * rowBytes,
               scanline + static_cast<ptrdiff_t>(y) * stride, rowBytes);
    }
    unlock();
    for (size_t i = 3; i < pixels.size(); i += 4) pixels[i] = 255;
    return true;
}
