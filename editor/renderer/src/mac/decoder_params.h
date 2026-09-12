#pragma once
// What a VideoDecoder needs from App to open on the GPU. macOS: the Metal
// device (for the CVMetalTextureCache) and the frame event that retires
// frames the renderer has finished sampling.

#include "video_decoder.h"

struct DecoderParams {
    ObjcRef device;          // id<MTLDevice>; empty = headless (CPU frames)
    bool nv12Mode = false;   // App can draw NV12 textures
    bool verbose = false;
    DecoderSync sync;
};
