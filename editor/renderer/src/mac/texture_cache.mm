#include "texture_cache.h"
#include "base64.h"
#include "image_io.h"
#include "metal_format.h"
#include "uri_util.h"

#import <Metal/Metal.h>
#include <algorithm>
#include <cstdio>
#include <cstring>

bool TextureCache::init(const ObjcRef& device, const ObjcRef& queue) {
    m_device = device;
    m_queue = queue;
    if (!m_device || !m_queue) {
        fprintf(stderr, "[TextureCache] No Metal device\n");
        return false;
    }
    printf("[TextureCache] Initialized (%d frames in flight)\n", FRAMES_IN_FLIGHT);
    return true;
}

void TextureCache::shutdown() {
    flushUploads();
    m_frameCmdBuf.reset();
    m_cache.clear();
}

void TextureCache::beginFrame(int frameIndex, uint64_t frameCounter,
                              const ObjcRef& commandBuffer, FrameGarbage*) {
    m_frameIndex = frameIndex % FRAMES_IN_FLIGHT;
    m_frameCounter = frameCounter;
    m_frameCmdBuf = commandBuffer;
}

ObjcRef TextureCache::blitEncoder() {
    if (m_blit) return m_blit;
    if (!m_frameCmdBuf) return {};
    id<MTLBlitCommandEncoder> enc = [objc<id<MTLCommandBuffer>>(m_frameCmdBuf) blitCommandEncoder];
    enc.label = @"texture uploads";
    m_blit = retainObjc(enc);
    return m_blit;
}

void TextureCache::flushUploads() {
    if (m_blit) {
        [objc<id<MTLBlitCommandEncoder>>(m_blit) endEncoding];
        m_blit.reset();
    }
}

ObjcRef TextureCache::createTexture(uint32_t width, uint32_t height, PixelFormat format) {
    MTLPixelFormat mtl = toMetal(format);
    if (mtl == MTLPixelFormatInvalid) return {};
    MTLTextureDescriptor* desc = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:mtl
        width:width height:height mipmapped:NO];
    desc.usage = MTLTextureUsageShaderRead;
    desc.storageMode = MTLStorageModePrivate;
    id<MTLTexture> tex = [objc<id<MTLDevice>>(m_device) newTextureWithDescriptor:desc];
    if (!tex) {
        fprintf(stderr, "[TextureCache] Failed to create %ux%u %s texture\n", width, height, pixelFormatName(format));
        return {};
    }
    return retainObjc(tex);
}

// --- Image loading ----------------------------------------------------------

const CachedTexture* TextureCache::get(const std::string& key, const std::string& uri) {
    auto it = m_cache.find(key);
    if (it != m_cache.end()) {
        it->second.lastReferencedFrame = m_frameCounter;
        return it->second.ready ? &it->second : nullptr;
    }

    CachedTexture* tex = loadInto(key, uri);
    if (tex) {
        tex->lastReferencedFrame = m_frameCounter;
        return tex;
    }
    // Insert a failed placeholder so we don't retry every frame
    m_cache[key].lastReferencedFrame = m_frameCounter;
    return nullptr;
}

const CachedTexture* TextureCache::peek(const std::string& key) {
    auto it = m_cache.find(key);
    if (it == m_cache.end()) return nullptr;
    it->second.lastReferencedFrame = m_frameCounter;
    return it->second.ready ? &it->second : nullptr;
}

bool TextureCache::decodeImage(const std::string& uri, std::vector<uint8_t>& pixels,
                               uint32_t& width, uint32_t& height) {
    if (isDataUri(uri)) {
        std::vector<uint8_t> bytes = decodeDataUriPayload(uri);
        if (bytes.empty()) return false;
        if (!decodeImageBytesRGBA(bytes.data(), bytes.size(), pixels, width, height)) {
            fprintf(stderr, "[TextureCache] Failed to decode data URI\n");
            return false;
        }
        return true;
    }
    std::string path = uriToPath(uri);
    if (path.empty()) return false;
    if (!decodeImageFileRGBA(path, pixels, width, height)) {
        fprintf(stderr, "[TextureCache] Failed to decode %s\n", path.c_str());
        return false;
    }
    return true;
}

CachedTexture* TextureCache::loadInto(const std::string& key, const std::string& uri) {
    std::vector<uint8_t> pixels;
    uint32_t width = 0, height = 0;
    if (!decodeImage(uri, pixels, width, height)) return nullptr;

    CachedTexture& cached = m_cache[key];
    if (!blockingUpload(cached, pixels.data(), width, height, PixelFormat::RGBA8)) {
        m_cache.erase(key);
        return nullptr;
    }
    printf("[TextureCache] Loaded %.60s (%ux%u)\n", uri.c_str(), width, height);
    return &cached;
}

// One-shot upload that waits for the GPU before returning. Used for the
// inline data: URI loads, which happen outside the frame's encoders.
bool TextureCache::blockingUpload(CachedTexture& cached, const uint8_t* pixels,
                                  uint32_t width, uint32_t height, PixelFormat format) {
    @autoreleasepool {
        ObjcRef texture = createTexture(width, height, format);
        if (!texture) return false;

        const size_t rb = rowBytes(format, width);
        const size_t size = rb * sourceRows(format, height);
        id<MTLBuffer> staging = [objc<id<MTLDevice>>(m_device) newBufferWithBytes:pixels length:size
            options:MTLResourceStorageModeShared];
        if (!staging) return false;

        id<MTLCommandBuffer> cb = [objc<id<MTLCommandQueue>>(m_queue) commandBuffer];
        id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
        [blit copyFromBuffer:staging sourceOffset:0 sourceBytesPerRow:rb sourceBytesPerImage:size
            sourceSize:MTLSizeMake(width, height, 1)
            toTexture:objc<id<MTLTexture>>(texture) destinationSlice:0 destinationLevel:0
            destinationOrigin:MTLOriginMake(0, 0, 0)];
        [blit endEncoding];
        [cb commit];
        [cb waitUntilCompleted];

        cached.texture = texture;
        cached.textureUV.reset();
        cached.width = width;
        cached.height = height;
        cached.format = format;
        cached.ready = true;
        cached.isNV12 = false;
        return true;
    }
}

// --- Per-frame pixel upload ---------------------------------------------

const CachedTexture* TextureCache::uploadPixels(const std::string& key, const uint8_t* pixels,
                                                 uint32_t width, uint32_t height,
                                                 PixelFormat format,
                                                 uint32_t dirtyTop, uint32_t dirtyBottom) {
    if (!pixels || width == 0 || height == 0) return nullptr;
    if (!m_frameCmdBuf) {
        fprintf(stderr, "[TextureCache] uploadPixels outside a frame\n");
        return nullptr;
    }

    auto it = m_cache.find(key);
    bool reuse = (it != m_cache.end() && it->second.ready && !it->second.isNV12 &&
                  it->second.width == width && it->second.height == height &&
                  it->second.format == format);

    // Several screens ask for the same video texture in one frame. Copying it
    // more than once would also mean overwriting the upload buffer a queued
    // copy is still reading from, so do it at most once per frame.
    if (reuse && it->second.lastUploadFrame == m_frameCounter) {
        it->second.lastReferencedFrame = m_frameCounter;
        return &it->second;
    }

    CachedTexture& cached = m_cache[key];
    cached.lastReferencedFrame = m_frameCounter;

    const size_t rb = rowBytes(format, width);
    const uint32_t numRows = sourceRows(format, height);
    const size_t uploadSize = rb * numRows;
    const bool blockCompressed = isBlockCompressed(format);
    const uint32_t rowsPer = rowsPerSourceRow(format);

    if (!reuse) {
        // A key changing dimensions (swapping a clip's media for a different
        // resolution) drops the old texture and the old upload buffers;
        // keeping undersized buffers would let the row copy below run past
        // the end of the mapping.
        ObjcRef texture = createTexture(width, height, format);
        if (!texture) return nullptr;
        for (auto& b : cached.uploadBuffers) b.reset();
        cached.uploadBufferSize = 0;
        cached.texture = texture;
        cached.textureUV.reset();
        cached.width = width;
        cached.height = height;
        cached.format = format;
        cached.isNV12 = false;
        cached.ready = true;
    }

    if (cached.uploadBufferSize != uploadSize) {
        for (auto& b : cached.uploadBuffers) b.reset();
        cached.uploadBufferSize = uploadSize;
    }
    ObjcRef& uploadRef = cached.uploadBuffers[m_frameIndex];
    if (!uploadRef) {
        id<MTLBuffer> buf = [objc<id<MTLDevice>>(m_device) newBufferWithLength:uploadSize
            options:MTLResourceStorageModeShared];
        if (!buf) return nullptr;
        uploadRef = retainObjc(buf);
        dirtyTop = 0;              // a fresh buffer holds nothing
        dirtyBottom = UINT32_MAX;
    }

    // A new texture must be filled completely regardless of the dirty hint,
    // and so must a block-compressed one: every frame replaces the whole
    // texture, and a partial region would have to land on block boundaries.
    if (!reuse || blockCompressed) { dirtyTop = 0; dirtyBottom = UINT32_MAX; }
    uint32_t top = std::min(dirtyTop, height);
    uint32_t bottom = std::min(dirtyBottom, height);
    if (bottom <= top) {
        // Nothing changed; the texture already holds the right content.
        cached.lastUploadFrame = m_frameCounter;
        return &cached;
    }

    // Source rows to copy: pixel rows, or block rows covering those pixels.
    const uint32_t rowTop = top / rowsPer;
    const uint32_t rowBottom = std::min((bottom + rowsPer - 1) / rowsPer, numRows);

    id<MTLBuffer> upload = objc<id<MTLBuffer>>(uploadRef);
    uint8_t* mapped = (uint8_t*)upload.contents;
    memcpy(mapped + (size_t)rowTop * rb, pixels + (size_t)rowTop * rb, (size_t)(rowBottom - rowTop) * rb);

    // The region is in texels either way; for blocks it snaps to block edges,
    // and a partial last block row is allowed when it reaches the edge.
    top = rowTop * rowsPer;
    bottom = std::min(rowBottom * rowsPer, height);

    ObjcRef blitRef = blitEncoder();
    if (!blitRef) return nullptr;
    id<MTLBlitCommandEncoder> blit = objc<id<MTLBlitCommandEncoder>>(blitRef);
    [blit copyFromBuffer:upload sourceOffset:(NSUInteger)rowTop * rb sourceBytesPerRow:rb
        sourceBytesPerImage:(NSUInteger)(rowBottom - rowTop) * rb
        sourceSize:MTLSizeMake(width, bottom - top, 1)
        toTexture:objc<id<MTLTexture>>(cached.texture) destinationSlice:0 destinationLevel:0
        destinationOrigin:MTLOriginMake(0, top, 0)];

    cached.lastUploadFrame = m_frameCounter;
    return &cached;
}

// --- External (video) textures ------------------------------------------

const CachedTexture* TextureCache::registerExternal(const std::string& key, const ObjcRef& texture,
                                                      uint32_t width, uint32_t height,
                                                      PixelFormat format) {
    if (!texture || width == 0 || height == 0) return nullptr;
    CachedTexture& cached = m_cache[key];
    for (auto& b : cached.uploadBuffers) b.reset();
    cached.uploadBufferSize = 0;
    cached.texture = texture;
    cached.textureUV.reset();
    cached.width = width;
    cached.height = height;
    cached.format = format;
    cached.isNV12 = false;
    cached.ready = true;
    cached.lastReferencedFrame = m_frameCounter;
    return &cached;
}

const CachedTexture* TextureCache::registerNV12(const std::string& key, const ObjcRef& yTexture,
                                                  const ObjcRef& uvTexture, uint32_t width, uint32_t height) {
    if (!yTexture || !uvTexture || width == 0 || height == 0) return nullptr;
    CachedTexture& cached = m_cache[key];
    for (auto& b : cached.uploadBuffers) b.reset();
    cached.uploadBufferSize = 0;
    cached.texture = yTexture;
    cached.textureUV = uvTexture;
    cached.width = width;
    cached.height = height;
    cached.format = PixelFormat::NV12;
    cached.isNV12 = true;
    cached.ready = true;
    cached.lastReferencedFrame = m_frameCounter;
    return &cached;
}

// --- Eviction ------------------------------------------------------------

void TextureCache::invalidate(const std::string& key, FrameGarbage&) {
    // The in-flight command buffers retain whatever they reference, so the
    // entry can simply go.
    m_cache.erase(key);
}

void TextureCache::evictUnused(uint64_t frameCounter, uint64_t graceFrames,
                               FrameGarbage&, std::vector<std::string>* evictedKeys) {
    for (auto it = m_cache.begin(); it != m_cache.end(); ) {
        CachedTexture& t = it->second;
        if (t.lastReferencedFrame + graceFrames >= frameCounter) { ++it; continue; }
        if (evictedKeys) evictedKeys->push_back(it->first);
        it = m_cache.erase(it);
    }
}

// --- Data URIs -----------------------------------------------------------

bool TextureCache::isDataUri(const std::string& uri) {
    return uri.size() > 5 && uri.compare(0, 5, "data:") == 0;
}
