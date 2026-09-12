#pragma once
// Texture formats named without reference to any one graphics API.
//
// The decoders, the HAP parser and the thumbnail path all describe pixels;
// the Windows backend maps these onto DXGI_FORMAT and the macOS backend onto
// MTLPixelFormat, so none of the shared code has to include either.

#include <cstddef>
#include <cstdint>

enum class PixelFormat : uint8_t {
    Unknown,
    RGBA8,   // 8-bit per channel, R first in memory
    BGRA8,   // 8-bit per channel, B first in memory
    BC1,     // DXT1: 8 bytes per 4x4 block
    BC3,     // DXT5: 16 bytes per 4x4 block
    BC4,     // RGTC1: 8 bytes per 4x4 block, one channel
    BC7,     // 16 bytes per 4x4 block
    NV12,    // two planes: Y, then interleaved UV at half resolution
};

inline bool isBlockCompressed(PixelFormat f) {
    return f == PixelFormat::BC1 || f == PixelFormat::BC3 ||
           f == PixelFormat::BC4 || f == PixelFormat::BC7;
}

/** Texel rows one row of the upload source covers: a block row is 4 texels. */
inline uint32_t rowsPerSourceRow(PixelFormat f) {
    return isBlockCompressed(f) ? 4u : 1u;
}

/** Bytes in one source row: a pixel row, or a row of blocks. */
inline size_t rowBytes(PixelFormat f, uint32_t width) {
    switch (f) {
    case PixelFormat::RGBA8:
    case PixelFormat::BGRA8: return (size_t)width * 4;
    case PixelFormat::BC1:
    case PixelFormat::BC4:   return (size_t)((width + 3) / 4) * 8;
    case PixelFormat::BC3:
    case PixelFormat::BC7:   return (size_t)((width + 3) / 4) * 16;
    case PixelFormat::NV12:  return (size_t)width;
    default:                 return 0;
    }
}

/** Source rows a texture of this height uploads as. */
inline uint32_t sourceRows(PixelFormat f, uint32_t height) {
    return isBlockCompressed(f) ? (height + 3) / 4 : height;
}

inline const char* pixelFormatName(PixelFormat f) {
    switch (f) {
    case PixelFormat::RGBA8: return "RGBA8";
    case PixelFormat::BGRA8: return "BGRA8";
    case PixelFormat::BC1:   return "BC1";
    case PixelFormat::BC3:   return "BC3";
    case PixelFormat::BC4:   return "BC4";
    case PixelFormat::BC7:   return "BC7";
    case PixelFormat::NV12:  return "NV12";
    default:                 return "unknown";
    }
}
