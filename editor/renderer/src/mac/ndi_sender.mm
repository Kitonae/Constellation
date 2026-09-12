#include "ndi_sender.h"

#import <Metal/Metal.h>
#include <cstdio>
#include <cstring>

#if !HAS_NDI
// Stub implementation when NDI SDK is not available
NDISender::~NDISender() {}
bool NDISender::init(const ObjcRef&, const std::string&, uint32_t, uint32_t, double) { return false; }
void NDISender::capture(const ObjcRef&, const ObjcRef&, uint64_t) {}
void NDISender::send(const ObjcRef&) {}
void NDISender::shutdown() {}
int NDISender::numConnections() const { return 0; }
#else

NDISender::~NDISender() { shutdown(); }

bool NDISender::init(const ObjcRef& deviceRef, const std::string& sourceName,
                     uint32_t width, uint32_t height, double fps) {
    if (!deviceRef || width == 0 || height == 0) return false;

    if (!NDIlib_initialize()) {
        printf("[NDI] NDIlib_initialize failed (CPU not supported?)\n");
        return false;
    }
    m_ndiInitialized = true;

    m_sourceName = sourceName;
    NDIlib_send_create_t createDesc;
    createDesc.p_ndi_name = m_sourceName.c_str();
    createDesc.p_groups = nullptr;
    createDesc.clock_video = true;
    createDesc.clock_audio = false;

    m_sender = NDIlib_send_create(&createDesc);
    if (!m_sender) {
        printf("[NDI] Failed to create sender '%s'\n", m_sourceName.c_str());
        return false;
    }

    m_width = width;
    m_height = height;
    m_rowPitch = width * 4;

    if (fps > 59.0 && fps < 61.0) {
        m_frameRateN = 60000; m_frameRateD = 1000;
    } else if (fps > 29.0 && fps < 31.0) {
        m_frameRateN = 30000; m_frameRateD = 1000;
    } else {
        m_frameRateN = (int)(fps * 1000.0); m_frameRateD = 1000;
    }

    id<MTLDevice> device = objc<id<MTLDevice>>(deviceRef);
    for (int i = 0; i < RING_SIZE; i++) {
        id<MTLBuffer> buf = [device newBufferWithLength:(NSUInteger)m_rowPitch * height
                                                options:MTLResourceStorageModeShared];
        if (!buf) {
            printf("[NDI] Staging buffer %d creation failed\n", i);
            shutdown();
            return false;
        }
        buf.label = @"NDI readback";
        m_staging[i] = retainObjc(buf);
    }

    m_ndiBuffers[0].resize((size_t)width * height * 4);
    m_ndiBuffers[1].resize((size_t)width * height * 4);

    printf("[NDI] Sender created: \"%s\" (%ux%u, %d/%d fps, ring=%d)\n",
        m_sourceName.c_str(), width, height, m_frameRateN, m_frameRateD, RING_SIZE);
    return true;
}

void NDISender::capture(const ObjcRef& commandBuffer, const ObjcRef& drawableRef, uint64_t frameFenceValue) {
    if (!m_sender || !commandBuffer || !drawableRef) return;
    id<MTLTexture> drawable = objc<id<MTLTexture>>(drawableRef);

    // The staging buffers and the NDI frame description are sized for
    // m_width x m_height; a differently sized screen must not be copied
    // through them.
    if (drawable.width != m_width || drawable.height != m_height) {
        static int warned = 0;
        if (warned++ % 600 == 0) {
            fprintf(stderr, "[NDI] Skipping capture: drawable %lux%lu != sender %ux%u\n",
                (unsigned long)drawable.width, (unsigned long)drawable.height, m_width, m_height);
        }
        return;
    }

    // Don't queue more than RING_SIZE frames
    if (m_pendingFrames >= RING_SIZE) return;

    int idx = m_captureIdx % RING_SIZE;
    id<MTLBlitCommandEncoder> blit = [objc<id<MTLCommandBuffer>>(commandBuffer) blitCommandEncoder];
    blit.label = @"NDI capture";
    [blit copyFromTexture:drawable sourceSlice:0 sourceLevel:0
        sourceOrigin:MTLOriginMake(0, 0, 0) sourceSize:MTLSizeMake(m_width, m_height, 1)
        toBuffer:objc<id<MTLBuffer>>(m_staging[idx]) destinationOffset:0
        destinationBytesPerRow:m_rowPitch destinationBytesPerImage:(NSUInteger)m_rowPitch * m_height];
    [blit endEncoding];

    m_fenceValues[idx] = frameFenceValue;
    m_captureIdx++;
    m_pendingFrames++;
}

void NDISender::send(const ObjcRef& frameEventRef) {
    if (!m_sender || m_pendingFrames <= 0) return;

    int idx = m_sendIdx % RING_SIZE;
    uint64_t required = m_fenceValues[idx];

    // Wait briefly for the GPU copy; the frame that produced it was just
    // committed, so it is usually a frame behind and already done.
    id<MTLSharedEvent> event = objc<id<MTLSharedEvent>>(frameEventRef);
    if (event && event.signaledValue < required) {
        [event waitUntilSignaledValue:required timeoutMS:5];
        if (event.signaledValue < required) return;   // still not done: skip this frame
    }

    // Alternate buffers: the SDK may still be reading the one handed to the
    // previous async call.
    std::vector<uint8_t>& ndiBuffer = m_ndiBuffers[m_ndiBufIdx];
    memcpy(ndiBuffer.data(), objc<id<MTLBuffer>>(m_staging[idx]).contents, (size_t)m_rowPitch * m_height);

    NDIlib_video_frame_v2_t frame;
    frame.xres = (int)m_width;
    frame.yres = (int)m_height;
    frame.FourCC = NDIlib_FourCC_video_type_BGRA;  // the drawable is BGRA8
    frame.frame_rate_N = m_frameRateN;
    frame.frame_rate_D = m_frameRateD;
    frame.picture_aspect_ratio = 0.0f;  // square pixels
    frame.frame_format_type = NDIlib_frame_format_type_progressive;
    frame.timecode = NDIlib_send_timecode_synthesize;
    frame.p_data = ndiBuffer.data();
    frame.line_stride_in_bytes = (int)m_rowPitch;
    frame.p_metadata = nullptr;
    frame.timestamp = 0;

    NDIlib_send_send_video_async_v2(m_sender, &frame);
    m_ndiBufIdx ^= 1;   // the SDK now owns `ndiBuffer` until the next call

    m_sendIdx++;
    m_pendingFrames--;
}

int NDISender::numConnections() const {
    if (!m_sender) return 0;
    return NDIlib_send_get_no_connections(m_sender, 0);
}

void NDISender::shutdown() {
    if (m_sender) {
        // Flush async send
        NDIlib_send_send_video_async_v2(m_sender, nullptr);
        NDIlib_send_destroy(m_sender);
        m_sender = nullptr;
    }
    for (auto& s : m_staging) s.reset();
    if (m_ndiInitialized) {
        NDIlib_destroy();
        m_ndiInitialized = false;
    }
    m_ndiBuffers[0].clear();
    m_ndiBuffers[1].clear();
    m_ndiBufIdx = 0;
    m_pendingFrames = 0;
    m_captureIdx = 0;
    m_sendIdx = 0;
    printf("[NDI] Sender destroyed\n");
}

#endif // HAS_NDI
