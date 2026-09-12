#include "hap_decoder.h"
#include "snappy_decode.h"

#include <algorithm>
#include <cstring>
#include <execution>
#include <numeric>

namespace {

// High nibble of a top-level section type: what wraps the blocks.
enum class Compressor : uint8_t {
    None    = 0xA,
    Snappy  = 0xB,
    Complex = 0xC,   // chunked, each chunk with its own second stage
};

// Section types inside a Complex frame.
constexpr uint8_t kDecodeInstructions   = 0x01;
constexpr uint8_t kChunkCompressorTable = 0x02;
constexpr uint8_t kChunkSizeTable       = 0x03;
constexpr uint8_t kChunkOffsetTable     = 0x04;
constexpr uint8_t kMultipleImages       = 0x0D;

struct Section {
    uint8_t        type = 0;
    const uint8_t* payload = nullptr;
    size_t         size = 0;
    size_t         totalSize = 0;   // header + payload
};

// Header: 24-bit little-endian size and a type byte. A zero size means the
// real size follows as 32 bits, for payloads over 16 MB.
bool readSection(const uint8_t* data, size_t avail, Section& out) {
    if (avail < 4) return false;
    size_t size = (size_t)data[0] | ((size_t)data[1] << 8) | ((size_t)data[2] << 16);
    size_t header = 4;
    if (size == 0) {
        if (avail < 8) return false;
        size = (size_t)data[4] | ((size_t)data[5] << 8) |
               ((size_t)data[6] << 16) | ((size_t)data[7] << 24);
        header = 8;
    }
    if (size > avail - header) return false;
    out.type = data[3];
    out.payload = data + header;
    out.size = size;
    out.totalSize = header + size;
    return true;
}

bool decodeOne(Compressor comp, const uint8_t* in, size_t inLen,
               uint8_t* out, size_t outLen, std::string& error) {
    switch (comp) {
    case Compressor::None:
        if (inLen != outLen) { error = "uncompressed chunk is the wrong size"; return false; }
        memcpy(out, in, outLen);
        return true;
    case Compressor::Snappy:
        if (!snappyUncompress(in, inLen, out, outLen)) { error = "snappy stream is malformed"; return false; }
        return true;
    default:
        error = "unknown second-stage compressor";
        return false;
    }
}

// The output size of one chunk, without decoding it: Snappy declares it up
// front, and an uncompressed chunk is its own size.
bool chunkOutputSize(Compressor comp, const uint8_t* in, size_t inLen, size_t& out) {
    if (comp == Compressor::None) { out = inLen; return true; }
    if (comp != Compressor::Snappy) return false;
    size_t header = 0;
    return snappyUncompressedLength(in, inLen, out, header);
}

bool decodeComplex(const uint8_t* payload, size_t size, uint8_t* out, size_t outLen,
                   std::string& error) {
    Section instructions;
    if (!readSection(payload, size, instructions) || instructions.type != kDecodeInstructions) {
        error = "chunked frame has no decode instructions";
        return false;
    }
    const uint8_t* frameData = payload + instructions.totalSize;
    const size_t frameBytes = size - instructions.totalSize;

    std::vector<Compressor> compressors;
    std::vector<uint32_t> sizes;
    std::vector<uint32_t> offsets;

    for (size_t pos = 0; pos < instructions.size; ) {
        Section s;
        if (!readSection(instructions.payload + pos, instructions.size - pos, s)) {
            error = "malformed decode instructions";
            return false;
        }
        if (s.type == kChunkCompressorTable) {
            compressors.resize(s.size);
            for (size_t i = 0; i < s.size; i++) compressors[i] = (Compressor)s.payload[i];
        } else if (s.type == kChunkSizeTable || s.type == kChunkOffsetTable) {
            auto& table = (s.type == kChunkSizeTable) ? sizes : offsets;
            table.resize(s.size / 4);
            for (size_t i = 0; i < table.size(); i++) {
                const uint8_t* p = s.payload + i * 4;
                table[i] = (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
                           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
            }
        }
        // Unknown instruction sections are permitted by the format; skip them.
        pos += s.totalSize;
    }

    const size_t count = compressors.size();
    if (count == 0 || sizes.size() != count) {
        error = "chunk tables are missing or disagree";
        return false;
    }
    if (!offsets.empty() && offsets.size() != count) {
        error = "chunk offset table does not match the chunk count";
        return false;
    }

    // Where each chunk starts in the input (given, or contiguous) and where its
    // output lands, so the chunks can then be decoded independently.
    std::vector<size_t> inOffset(count), outOffset(count), outSize(count);
    size_t inPos = 0, outPos = 0;
    for (size_t i = 0; i < count; i++) {
        inOffset[i] = offsets.empty() ? inPos : offsets[i];
        if (inOffset[i] > frameBytes || sizes[i] > frameBytes - inOffset[i]) {
            error = "chunk lies outside the frame";
            return false;
        }
        if (!chunkOutputSize(compressors[i], frameData + inOffset[i], sizes[i], outSize[i])) {
            error = "chunk declares no output size";
            return false;
        }
        outOffset[i] = outPos;
        if (outSize[i] > outLen - outPos) {
            error = "chunks decode to more than one texture";
            return false;
        }
        inPos = inOffset[i] + sizes[i];
        outPos += outSize[i];
    }
    if (outPos != outLen) {
        error = "chunks decode to less than one texture";
        return false;
    }

    // Each chunk is a self-contained stream writing a disjoint output range, so
    // they can run on every core; a 4K frame is many megabytes of Snappy.
    std::vector<size_t> index(count);
    std::iota(index.begin(), index.end(), (size_t)0);
    std::vector<uint8_t> failed(count, 0);
    std::for_each(std::execution::par_unseq, index.begin(), index.end(), [&](size_t i) {
        std::string localError;
        if (!decodeOne(compressors[i], frameData + inOffset[i], sizes[i],
                       out + outOffset[i], outSize[i], localError)) {
            failed[i] = 1;
        }
    });
    for (size_t i = 0; i < count; i++) {
        if (failed[i]) { error = "a chunk failed to decompress"; return false; }
    }
    return true;
}

}  // namespace

DXGI_FORMAT hapDxgiFormat(HapFormat format) {
    switch (format) {
    case HapFormat::RGB_DXT1:   return DXGI_FORMAT_BC1_UNORM;
    case HapFormat::RGBA_DXT5:  return DXGI_FORMAT_BC3_UNORM;
    case HapFormat::YCoCg_DXT5: return DXGI_FORMAT_BC3_UNORM;
    case HapFormat::A_RGTC1:    return DXGI_FORMAT_BC4_UNORM;
    case HapFormat::RGBA_BC7:   return DXGI_FORMAT_BC7_UNORM;
    default:                    return DXGI_FORMAT_UNKNOWN;
    }
}

size_t hapTextureBytes(HapFormat format, uint32_t width, uint32_t height) {
    // Blocks are 4x4 texels; a partial block still costs a whole one.
    const size_t blocks = (size_t)((width + 3) / 4) * ((height + 3) / 4);
    switch (format) {
    case HapFormat::RGB_DXT1:
    case HapFormat::A_RGTC1:    return blocks * 8;
    case HapFormat::RGBA_DXT5:
    case HapFormat::YCoCg_DXT5:
    case HapFormat::RGBA_BC7:   return blocks * 16;
    default:                    return 0;
    }
}

const char* hapFormatName(HapFormat format) {
    switch (format) {
    case HapFormat::RGB_DXT1:   return "Hap";
    case HapFormat::RGBA_DXT5:  return "Hap Alpha";
    case HapFormat::YCoCg_DXT5: return "Hap Q";
    case HapFormat::A_RGTC1:    return "Hap Alpha-Only";
    case HapFormat::RGBA_BC7:   return "Hap R";
    default:                    return "unknown";
    }
}

bool hapFormatFromFourcc(uint32_t fourcc, HapFormat& format) {
    // Both byte orders, because the QuickTime tag reaches Media Foundation
    // swapped relative to MAKEFOURCC.
    auto match = [fourcc](char a, char b, char c, char d) {
        const uint32_t le = (uint32_t)(uint8_t)a | ((uint32_t)(uint8_t)b << 8) |
                            ((uint32_t)(uint8_t)c << 16) | ((uint32_t)(uint8_t)d << 24);
        const uint32_t be = ((uint32_t)(uint8_t)a << 24) | ((uint32_t)(uint8_t)b << 16) |
                            ((uint32_t)(uint8_t)c << 8) | (uint32_t)(uint8_t)d;
        return fourcc == le || fourcc == be;
    };
    if (match('H', 'a', 'p', '1')) { format = HapFormat::RGB_DXT1;   return true; }
    if (match('H', 'a', 'p', '5')) { format = HapFormat::RGBA_DXT5;  return true; }
    if (match('H', 'a', 'p', 'Y')) { format = HapFormat::YCoCg_DXT5; return true; }
    if (match('H', 'a', 'p', 'A')) { format = HapFormat::A_RGTC1;    return true; }
    if (match('H', 'a', 'p', '7')) { format = HapFormat::RGBA_BC7;   return true; }
    // Hap Q Alpha carries two textures per frame; recognised so the caller can
    // say why it is refused rather than reporting an unknown codec.
    if (match('H', 'a', 'p', 'M')) { format = HapFormat::Unknown;    return true; }
    return false;
}

bool hapDecodeFrame(const uint8_t* data, size_t size, uint32_t width, uint32_t height,
                    std::vector<uint8_t>& blocks, HapFormat& format, std::string& error) {
    error.clear();
    format = HapFormat::Unknown;

    Section top;
    if (!readSection(data, size, top)) {
        error = "frame is shorter than its section header";
        return false;
    }
    if (top.type == kMultipleImages) {
        error = "Hap Q Alpha (two textures per frame) is not supported";
        return false;
    }

    format = (HapFormat)(top.type & 0x0F);
    const Compressor comp = (Compressor)(top.type >> 4);

    const size_t textureBytes = hapTextureBytes(format, width, height);
    if (textureBytes == 0) {
        error = "unknown texture format";
        return false;
    }
    if (format == HapFormat::A_RGTC1) {
        error = "Hap Alpha-Only carries a matte, not a picture";
        return false;
    }

    blocks.resize(textureBytes);

    if (comp == Compressor::Complex)
        return decodeComplex(top.payload, top.size, blocks.data(), textureBytes, error);
    return decodeOne(comp, top.payload, top.size, blocks.data(), textureBytes, error);
}
