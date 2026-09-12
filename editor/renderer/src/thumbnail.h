#pragma once
// Headless thumbnail extraction: one frame of a video file, written as a PNG.
//
// The editor makes its thumbnails in the browser, and the browser cannot
// decode HAP (or HEVC without the codec pack). This path uses the same
// VideoDecoder the renderer plays with, so anything the renderer can show,
// the media bin can preview. No window, no device: HAP needs none, and the
// other codecs fall to Media Foundation's software path, which is plenty
// for a single frame.

#include <cstdint>
#include <string>

/**
 * Decode the frame at `timeSeconds` and write it to `outPng`, scaled to fit
 * within `maxDim` on its longer side.
 *
 * @return 0 on success, non-zero with a message on stderr otherwise. A frame
 *         in a block format this decoder cannot unpack on the CPU (BC7) is a
 *         failure, not a garbage image.
 */
int runThumbnail(const std::string& inPath, const std::string& outPng,
                 double timeSeconds, uint32_t maxDim);
