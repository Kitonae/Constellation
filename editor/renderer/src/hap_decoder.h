#pragma once
// HAP frame decoding.
//
// A HAP frame is a block-compressed GPU texture -- DXT1, DXT5, BC7 -- wrapped
// in one section header and, usually, Snappy. Decoding is therefore not
// decoding at all in the codec sense: strip the header, undo the Snappy, and
// what is left is the texture, byte for byte, ready to upload. That is the
// whole point of the format and why media servers standardise on it.
//
// Media Foundation demultiplexes the container and hands over one frame per
// sample; this parses the sections. Chunked frames (the "complex" second
// stage, one Snappy stream per chunk) are decompressed in parallel, because a
// 4K frame is 17 MB of texture and a single core does not clear that at 60 Hz.
//
// Supported: Hap (DXT1), Hap Alpha (DXT5), Hap Q (scaled YCoCg in DXT5, which
// the pixel shader converts) and Hap R (BC7). Not supported: Hap Alpha-Only,
// whose single channel is a matte for a compositing pipeline rather than a
// picture, and Hap Q Alpha, whose frame carries two textures.

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include <dxgiformat.h>

// Low nibble of a top-level section type: what the blocks are.
enum class HapFormat : uint8_t {
    Unknown    = 0x0,
    A_RGTC1    = 0x1,   // Hap Alpha-Only: one channel, BC4
    RGB_DXT1   = 0xB,   // Hap
    RGBA_BC7   = 0xC,   // Hap R
    RGBA_DXT5  = 0xE,   // Hap Alpha
    YCoCg_DXT5 = 0xF,   // Hap Q: DXT5 holding scaled YCoCg, not RGBA
};

/** The DXGI format that reads these blocks as the texture they are. */
DXGI_FORMAT hapDxgiFormat(HapFormat format);

/** Bytes one texture of this format occupies at this size. */
size_t hapTextureBytes(HapFormat format, uint32_t width, uint32_t height);

const char* hapFormatName(HapFormat format);

/**
 * Decode one HAP frame into texture blocks.
 *
 * `blocks` is resized to exactly hapTextureBytes(format, width, height); a
 * frame whose payload decodes to any other size is refused, because the
 * upload that follows trusts the size and would otherwise read past the
 * buffer. On failure `error` says why, `format` and `blocks` are unspecified.
 */
bool hapDecodeFrame(const uint8_t* data, size_t size, uint32_t width, uint32_t height,
                    std::vector<uint8_t>& blocks, HapFormat& format, std::string& error);

/** The fourcc a HAP sample description carries, or false if it is not HAP. */
bool hapFormatFromFourcc(uint32_t fourcc, HapFormat& format);
