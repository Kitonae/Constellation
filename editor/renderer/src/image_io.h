#pragma once
// Still-image decoding and PNG writing behind the platform's own codecs: WIC
// on Windows, ImageIO on macOS.

#include <cstdint>
#include <string>
#include <vector>

// Decode the first frame of an image file to tightly packed RGBA8 with
// straight (non-premultiplied) alpha, the layout the blend state expects.
bool decodeImageFileRGBA(const std::string& path, std::vector<uint8_t>& rgba,
                         uint32_t& width, uint32_t& height);

// The same, from encoded bytes already in memory (data: URIs).
bool decodeImageBytesRGBA(const uint8_t* data, size_t size, std::vector<uint8_t>& rgba,
                          uint32_t& width, uint32_t& height);

// Write tightly packed BGRA8 as a PNG.
bool writePngBGRA(const std::string& path, const std::vector<uint8_t>& bgra,
                  uint32_t width, uint32_t height);
