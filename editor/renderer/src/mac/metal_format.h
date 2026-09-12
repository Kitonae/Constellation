#pragma once
// PixelFormat <-> MTLPixelFormat, for the macOS backend only.

#include "pixel_format.h"
#import <Metal/Metal.h>

inline MTLPixelFormat toMetal(PixelFormat f) {
    switch (f) {
    case PixelFormat::RGBA8: return MTLPixelFormatRGBA8Unorm;
    case PixelFormat::BGRA8: return MTLPixelFormatBGRA8Unorm;
    case PixelFormat::BC1:   return MTLPixelFormatBC1_RGBA;
    case PixelFormat::BC3:   return MTLPixelFormatBC3_RGBA;
    case PixelFormat::BC4:   return MTLPixelFormatBC4_RUnorm;
    case PixelFormat::BC7:   return MTLPixelFormatBC7_RGBAUnorm;
    default:                 return MTLPixelFormatInvalid;
    }
}
