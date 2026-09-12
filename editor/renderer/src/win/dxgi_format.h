#pragma once
// PixelFormat <-> DXGI_FORMAT, for the Windows backend only.

#include "pixel_format.h"
#include <dxgiformat.h>

inline DXGI_FORMAT toDxgi(PixelFormat f) {
    switch (f) {
    case PixelFormat::RGBA8: return DXGI_FORMAT_R8G8B8A8_UNORM;
    case PixelFormat::BGRA8: return DXGI_FORMAT_B8G8R8A8_UNORM;
    case PixelFormat::BC1:   return DXGI_FORMAT_BC1_UNORM;
    case PixelFormat::BC3:   return DXGI_FORMAT_BC3_UNORM;
    case PixelFormat::BC4:   return DXGI_FORMAT_BC4_UNORM;
    case PixelFormat::BC7:   return DXGI_FORMAT_BC7_UNORM;
    case PixelFormat::NV12:  return DXGI_FORMAT_NV12;
    default:                 return DXGI_FORMAT_UNKNOWN;
    }
}
