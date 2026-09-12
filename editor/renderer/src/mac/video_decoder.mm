#include "video_decoder.h"
#include "decoder_params.h"
#include "video_buffer.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <Metal/Metal.h>
#import <VideoToolbox/VideoToolbox.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace {

std::string fourccString(uint32_t code) {
    char s[5] = {
        (char)((code >> 24) & 0xFF), (char)((code >> 16) & 0xFF),
        (char)((code >> 8) & 0xFF), (char)(code & 0xFF), 0 };
    for (char& c : s) if (c != 0 && (c < 32 || c > 126)) c = '?';
    return s;
}

const char* codecNameFor(uint32_t subtype) {
    switch (subtype) {
    case kCMVideoCodecType_H264:            return "H.264";
    case kCMVideoCodecType_HEVC:
    case kCMVideoCodecType_HEVCWithAlpha:   return "HEVC";
    case kCMVideoCodecType_AppleProRes422:
    case kCMVideoCodecType_AppleProRes422HQ:
    case kCMVideoCodecType_AppleProRes422LT:
    case kCMVideoCodecType_AppleProRes422Proxy:
    case kCMVideoCodecType_AppleProRes4444:
    case kCMVideoCodecType_AppleProRes4444XQ:
    case kCMVideoCodecType_AppleProResRAW:
    case kCMVideoCodecType_AppleProResRAWHQ: return "ProRes";
    case kCMVideoCodecType_VP9:             return "VP9";
    case kCMVideoCodecType_AV1:             return "AV1";
    case kCMVideoCodecType_MPEG4Video:      return "MPEG-4";
    case kCMVideoCodecType_JPEG:
    case kCMVideoCodecType_JPEG_OpenDML:    return "MJPEG";
    default:                                return nullptr;
    }
}

// Matrix coefficients from the CoreMedia/CoreVideo constant names, or false.
bool matrixCoefficients(CFTypeRef value, float& kr, float& kb) {
    if (!value || CFGetTypeID(value) != CFStringGetTypeID()) return false;
    CFStringRef s = (CFStringRef)value;
    if (CFEqual(s, kCVImageBufferYCbCrMatrix_ITU_R_709_2))  { kr = 0.2126f; kb = 0.0722f; return true; }
    if (CFEqual(s, kCVImageBufferYCbCrMatrix_ITU_R_601_4))  { kr = 0.299f;  kb = 0.114f;  return true; }
    if (CFEqual(s, kCVImageBufferYCbCrMatrix_SMPTE_240M_1995)) { kr = 0.212f; kb = 0.087f; return true; }
    if (CFEqual(s, kCVImageBufferYCbCrMatrix_ITU_R_2020))   { kr = 0.2627f; kb = 0.0593f; return true; }
    return false;
}

} // namespace

VideoDecoder::~VideoDecoder() { close(); }

bool VideoDecoder::open(const std::string& filePath) {
    return open(filePath, DecoderParams{});
}

bool VideoDecoder::open(const std::string& filePath, const DecoderParams& params) {
    close();
    m_sync = params.sync;
    m_device = params.device;

    @autoreleasepool {
        if (!loadAsset(filePath)) {
            fprintf(stderr, "[VideoDecoder] Cannot open %s\n", filePath.c_str());
            close();
            return false;
        }

        // Decide the decode path once, here. Each attempt fully configures the
        // reader and proves it on this file; on failure the next mode is
        // tried from scratch. The decode thread never changes mode.
        bool opened = tryOpen(Mode::Hap);
        if (!opened && m_device && params.nv12Mode) {
            opened = tryOpen(Mode::NV12);
            if (!opened) printf("[VideoDecoder] NV12 path unavailable, trying software\n");
        }
        if (!opened) opened = tryOpen(Mode::Software);
        if (!opened) {
            fprintf(stderr, "[VideoDecoder] Failed to open %s in any mode\n", filePath.c_str());
            close();
            return false;
        }
    }

    m_open = true;
    m_running = true;
    m_targetTime = 0.0;
    m_thread = std::thread(&VideoDecoder::decodeThread, this);

    const char* mode = m_mode == Mode::Hap ? "HAP_TEXTURE_BLOCKS" :
                       m_mode == Mode::NV12 ? "VT+NV12_ZEROCOPY" : "SOFTWARE_BGRA";
    printf("[VideoDecoder] Opened %s (%ux%u, %.1f fps, %.1fs, %s %s)\n",
        filePath.c_str(), m_width, m_height, m_fps, m_duration, m_codecName.c_str(), mode);
    return true;
}

// Load the asset and its first video track, and read what the container says
// about it: size, rate, duration, codec and colour metadata.
bool VideoDecoder::loadAsset(const std::string& filePath) {
    NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:filePath.c_str()]];
    AVURLAsset* asset = [AVURLAsset URLAssetWithURL:url
        options:@{ AVURLAssetPreferPreciseDurationAndTimingKey: @YES }];
    if (!asset) return false;

    // Block on the asynchronous loads. These decoders open on the loader
    // thread, which exists to wait on exactly this kind of thing.
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSArray<AVAssetTrack*>* tracks = nil;
    [asset loadTracksWithMediaType:AVMediaTypeVideo
                 completionHandler:^(NSArray<AVAssetTrack*>* t, NSError*) {
        tracks = t;
        dispatch_semaphore_signal(sem);
    }];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
    if (tracks.count == 0) return false;
    AVAssetTrack* track = tracks[0];

    [asset loadValuesAsynchronouslyForKeys:@[@"duration"]
                         completionHandler:^{ dispatch_semaphore_signal(sem); }];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
    [track loadValuesAsynchronouslyForKeys:@[@"formatDescriptions", @"naturalSize", @"nominalFrameRate"]
                         completionHandler:^{ dispatch_semaphore_signal(sem); }];
    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

    CGSize size = track.naturalSize;
    m_width = (uint32_t)std::lround(size.width);
    m_height = (uint32_t)std::lround(size.height);
    if (m_width == 0 || m_height == 0) return false;

    float rate = track.nominalFrameRate;
    m_fps = (rate > 0.0f) ? (double)rate : 30.0;
    m_frameDuration = 1.0 / m_fps;

    CMTime duration = asset.duration;
    m_duration = CMTIME_IS_NUMERIC(duration) ? CMTimeGetSeconds(duration) : 0.0;

    NSArray* descs = track.formatDescriptions;
    if (descs.count == 0) return false;
    CMFormatDescriptionRef fd = (__bridge CMFormatDescriptionRef)descs[0];
    m_subtype = CMFormatDescriptionGetMediaSubType(fd);
    if (const char* name = codecNameFor(m_subtype)) m_codecName = name;
    else m_codecName = fourccString(m_subtype);
    readColorSpace(fd);

    m_asset = retainObjc(asset);
    m_track = retainObjc(track);
    return true;
}

// Fill m_colorSpace from the format description: nominal range and matrix.
// Without this the NV12 shader would assume BT.709 limited range for
// everything, so SD (BT.601) and full-range content came out wrong.
void VideoDecoder::readColorSpace(const void* formatDescription) {
    CMFormatDescriptionRef fd = (CMFormatDescriptionRef)formatDescription;
    m_fullRange = false;
    if (fd) {
        CFTypeRef full = CMFormatDescriptionGetExtension(fd, kCMFormatDescriptionExtension_FullRangeVideo);
        if (full && CFGetTypeID(full) == CFBooleanGetTypeID()) m_fullRange = CFBooleanGetValue((CFBooleanRef)full);
    }
    if (m_fullRange) {
        m_colorSpace.yOffset = 0.0f;
        m_colorSpace.yScale = 1.0f;
        m_colorSpace.cOffset = 128.0f / 255.0f;
        m_colorSpace.cScale = 1.0f;
    } else {
        // Studio/limited range (the default for camera and broadcast content)
        m_colorSpace.yOffset = 16.0f / 255.0f;
        m_colorSpace.yScale = 255.0f / 219.0f;
        m_colorSpace.cOffset = 128.0f / 255.0f;
        m_colorSpace.cScale = 255.0f / 224.0f;
    }

    float kr = 0, kb = 0;
    CFTypeRef matrix = fd ? CMFormatDescriptionGetExtension(fd, kCMFormatDescriptionExtension_YCbCrMatrix) : nullptr;
    if (!matrixCoefficients(matrix, kr, kb)) {
        // No metadata: SD resolutions are BT.601, HD and up are BT.709.
        if (m_height > 0 && m_height <= 576) { kr = 0.299f; kb = 0.114f; }
        else { kr = 0.2126f; kb = 0.0722f; }
    }
    m_colorSpace.kr = kr;
    m_colorSpace.kb = kb;
}

// The first decoded picture carries the matrix VideoToolbox worked out from
// the bitstream (the VUI), which is authoritative when the container had no
// colour box. Read it once.
void VideoDecoder::applyFrameColorSpace(CVPixelBufferRef pb) {
    if (m_frameColorSpaceRead || !pb) return;
    m_frameColorSpaceRead = true;
    CFTypeRef matrix = CVBufferCopyAttachment(pb, kCVImageBufferYCbCrMatrixKey, nullptr);
    if (!matrix) return;
    float kr = 0, kb = 0;
    if (matrixCoefficients(matrix, kr, kb)) {
        m_colorSpace.kr = kr;
        m_colorSpace.kb = kb;
    }
    CFRelease(matrix);
}

// Configure for one decode mode and prove it on this file. Returns false
// with the reader released so open() can try the next mode.
bool VideoDecoder::tryOpen(Mode mode) {
    destroyReader();
    m_writeable.clear();
    m_readable.clear();
    m_display = VideoFrame{};
    m_poolSize = POOL_SIZE;
    m_hapFormat = HapFormat::Unknown;
    m_hardware = false;
    m_frameColorSpaceRead = false;
    m_outputSettings.reset();

    if (mode == Mode::Hap) {
        // HAP is not another way of decoding the same stream but a different
        // codec altogether -- one VideoToolbox has no decoder for. Its frames
        // are GPU texture blocks under Snappy; the only work is undoing the
        // Snappy. The track's own fourcc says whether this is HAP at all.
        HapFormat declared = HapFormat::Unknown;
        if (!hapFormatFromFourcc(m_subtype, declared)) return false;
        if (declared == HapFormat::Unknown || declared == HapFormat::A_RGTC1) {
            printf("[VideoDecoder] %s is not supported: only Hap, Hap Alpha, Hap Q and Hap R\n",
                declared == HapFormat::A_RGTC1 ? "Hap Alpha-Only" : "Hap Q Alpha");
            return false;
        }
        m_hapFormat = declared;
        m_codecName = hapFormatName(declared);
        m_mode = Mode::Hap;
        // nil output settings: the compressed samples pass straight through.
        if (!createReader(0.0)) return false;

        // Prove the first frame decodes before committing: a container can
        // carry the right tag over frames this parser cannot read.
        VideoFrame probe;
        if (!readHapFrame(probe)) {
            printf("[VideoDecoder] %s: first frame did not decode\n", m_codecName.c_str());
            destroyReader();
            m_mode = Mode::Software;
            return false;
        }
        m_decodedFrames.store(0);
        destroyReader();
        // Every frame is a keyframe and they arrive in order, so the default
        // pool is plenty; the block buffers are sized by the first decode.
        for (int i = 0; i < m_poolSize; i++) {
            VideoFrame f;
            f.width = m_width;
            f.height = m_height;
            m_writeable.push_back(std::move(f));
        }
        return true;
    }

    if (hapFormatFromFourcc(m_subtype, m_hapFormat)) {
        // A HAP variant this renderer refused above; VideoToolbox has no
        // decoder for it either.
        m_hapFormat = HapFormat::Unknown;
        return false;
    }

    if (mode == Mode::NV12) {
        if (!m_device) return false;
        if (!m_textureCache) {
            CVMetalTextureCacheRef cache = nullptr;
            CVReturn rc = CVMetalTextureCacheCreate(kCFAllocatorDefault, nullptr,
                objc<id<MTLDevice>>(m_device), nullptr, &cache);
            m_textureCache = cache;
            if (rc != kCVReturnSuccess || !m_textureCache) {
                printf("[VideoDecoder] CVMetalTextureCacheCreate failed: %d\n", (int)rc);
                return false;
            }
        }
        OSType pixelFormat = m_fullRange ? kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
                                         : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
        m_outputSettings = retainObjc(@{
            (id)kCVPixelBufferPixelFormatTypeKey: @(pixelFormat),
            (id)kCVPixelBufferMetalCompatibilityKey: @YES,
            (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
        });
        m_mode = Mode::NV12;
    } else {
        m_outputSettings = retainObjc(@{
            (id)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        });
        m_mode = Mode::Software;
    }

    if (!createReader(0.0)) return false;

    // Prove the whole chain on this stream before committing to it: the
    // reader accepts the settings, a picture comes out, and (for NV12) both
    // planes become Metal textures.
    VideoFrame probe;
    if (!readDecodedFrame(probe)) {
        printf("[VideoDecoder] %s probe produced no picture\n", mode == Mode::NV12 ? "NV12" : "BGRA");
        destroyReader();
        return false;
    }
    if (mode == Mode::NV12 && !probe.hasGpuTexture()) {
        destroyReader();
        return false;
    }
    // Adopt the decoded size: the container's naturalSize can disagree with
    // what VideoToolbox delivers.
    if (probe.width > 0 && probe.height > 0) { m_width = probe.width; m_height = probe.height; }
    m_decodedFrames.store(0);
    probe = VideoFrame{};
    destroyReader();

    m_hardware = VTIsHardwareDecodeSupported(m_subtype);

    for (int i = 0; i < m_poolSize; i++) {
        VideoFrame f;
        f.width = m_width;
        f.height = m_height;
        if (mode == Mode::Software) f.pixels.resize((size_t)m_width * m_height * 4);
        m_writeable.push_back(std::move(f));
    }
    return true;
}

bool VideoDecoder::createReader(double startSeconds) {
    destroyReader();
    @autoreleasepool {
        AVURLAsset* asset = objc<AVURLAsset*>(m_asset);
        AVAssetTrack* track = objc<AVAssetTrack*>(m_track);
        if (!asset || !track) return false;

        NSError* error = nil;
        AVAssetReader* reader = [AVAssetReader assetReaderWithAsset:asset error:&error];
        if (!reader) {
            fprintf(stderr, "[VideoDecoder] AVAssetReader: %s\n",
                error ? error.localizedDescription.UTF8String : "unknown error");
            return false;
        }
        AVAssetReaderTrackOutput* output = [AVAssetReaderTrackOutput
            assetReaderTrackOutputWithTrack:track
                             outputSettings:objc<NSDictionary*>(m_outputSettings)];
        if (!output) return false;
        output.alwaysCopiesSampleData = NO;
        if (![reader canAddOutput:output]) {
            fprintf(stderr, "[VideoDecoder] reader refuses the track output\n");
            return false;
        }
        [reader addOutput:output];

        CMTime start = CMTimeMakeWithSeconds(std::max(0.0, startSeconds), 600);
        reader.timeRange = CMTimeRangeMake(start, kCMTimePositiveInfinity);
        if (![reader startReading]) {
            fprintf(stderr, "[VideoDecoder] startReading failed: %s\n",
                reader.error ? reader.error.localizedDescription.UTF8String : "unknown error");
            return false;
        }
        m_reader = retainObjc(reader);
        m_output = retainObjc(output);
        return true;
    }
}

void VideoDecoder::destroyReader() {
    @autoreleasepool {
        if (m_reader) {
            AVAssetReader* reader = objc<AVAssetReader*>(m_reader);
            if (reader.status == AVAssetReaderStatusReading) [reader cancelReading];
        }
        m_output.reset();
        m_reader.reset();
    }
}

void VideoDecoder::close() {
    if (m_running) {
        m_running = false;
        m_seekCv.notify_all();
        m_writeableCv.notify_all();
        if (m_thread.joinable()) m_thread.join();
    }
    destroyReader();
    m_writeable.clear();
    m_readable.clear();
    m_display = VideoFrame{};
    if (m_textureCache) {
        CVMetalTextureCacheFlush((CVMetalTextureCacheRef)m_textureCache, 0);
        CFRelease(m_textureCache);
        m_textureCache = nullptr;
    }
    m_outputSettings.reset();
    m_track.reset();
    m_asset.reset();
    m_device.reset();
    m_open = false;
    m_mode = Mode::Software;
    m_hapFormat = HapFormat::Unknown;
    m_hardware = false;
    m_sync = {};
    m_width = m_height = 0;
    m_duration = 0; m_fps = 30.0;
    m_codecName = "unknown";
    m_subtype = 0;
}

int VideoDecoder::readableCount() const {
    std::lock_guard<std::mutex> lk(m_dealerMu);
    return (int)m_readable.size();
}

// --- Reading frames --------------------------------------------------------

// One HAP frame: one sample, one Snappy pass, one texture.
bool VideoDecoder::readHapFrame(VideoFrame& dest) {
    AVAssetReaderTrackOutput* output = objc<AVAssetReaderTrackOutput*>(m_output);
    if (!output) return false;

    int failures = 0;
    for (int attempt = 0; attempt < 64; attempt++) {
        CMSampleBufferRef sample = [output copyNextSampleBuffer];
        if (!sample) return false;

        CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
        size_t length = block ? CMBlockBufferGetDataLength(block) : 0;
        if (length == 0) { CFRelease(sample); continue; }

        // Usually one contiguous block; copy out when it is not.
        const uint8_t* data = nullptr;
        size_t avail = 0;
        std::vector<uint8_t> scratch;
        char* ptr = nullptr;
        if (CMBlockBufferGetDataPointer(block, 0, &avail, nullptr, &ptr) == kCMBlockBufferNoErr &&
            avail >= length) {
            data = (const uint8_t*)ptr;
        } else {
            scratch.resize(length);
            if (CMBlockBufferCopyDataBytes(block, 0, length, scratch.data()) != kCMBlockBufferNoErr) {
                CFRelease(sample);
                return false;
            }
            data = scratch.data();
        }

        HapFormat format = HapFormat::Unknown;
        std::string error;
        const bool ok = hapDecodeFrame(data, length, m_width, m_height, dest.pixels, format, error);
        CMTime pts = CMSampleBufferGetOutputPresentationTimeStamp(sample);
        CFRelease(sample);

        if (!ok) {
            // A damaged frame is skipped, not treated as the end of the file;
            // only a run of them means the stream is unreadable.
            if (failures++ == 0) printf("[VideoDecoder] HAP frame rejected: %s\n", error.c_str());
            if (failures >= 16) return false;
            continue;
        }

        dest.releaseGpu();
        dest.width = m_width;
        dest.height = m_height;
        dest.codedWidth = dest.codedHeight = 0;
        dest.timestamp = CMTIME_IS_NUMERIC(pts) ? CMTimeGetSeconds(pts) : 0.0;
        dest.nv12 = false;
        dest.pixelFormat = hapPixelFormat(format);
        dest.ycocg = (format == HapFormat::YCoCg_DXT5);
        m_decodedFrames.fetch_add(1);
        return true;
    }
    return false;
}

// One decoded picture: NV12 planes wrapped as Metal textures, or BGRA copied
// to the CPU.
bool VideoDecoder::readDecodedFrame(VideoFrame& dest) {
    AVAssetReaderTrackOutput* output = objc<AVAssetReaderTrackOutput*>(m_output);
    if (!output) return false;

    for (int attempt = 0; attempt < 8; attempt++) {
        CMSampleBufferRef sample = [output copyNextSampleBuffer];
        if (!sample) return false;
        CVImageBufferRef image = CMSampleBufferGetImageBuffer(sample);
        if (!image) { CFRelease(sample); continue; }   // a sample with no picture

        CMTime pts = CMSampleBufferGetOutputPresentationTimeStamp(sample);
        const double ts = CMTIME_IS_NUMERIC(pts) ? CMTimeGetSeconds(pts) : 0.0;
        const uint32_t w = (uint32_t)CVPixelBufferGetWidth(image);
        const uint32_t h = (uint32_t)CVPixelBufferGetHeight(image);

        dest.releaseGpu();
        bool ok = false;
        if (m_mode == Mode::NV12) {
            applyFrameColorSpace(image);
            static const MTLPixelFormat planeFormats[2] = { MTLPixelFormatR8Unorm, MTLPixelFormatRG8Unorm };
            ok = CVPixelBufferGetPlaneCount(image) == 2;
            for (size_t plane = 0; ok && plane < 2; plane++) {
                CVMetalTextureRef planeTexture = nullptr;
                CVReturn rc = CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault,
                    (CVMetalTextureCacheRef)m_textureCache, image, nullptr, planeFormats[plane],
                    CVPixelBufferGetWidthOfPlane(image, plane), CVPixelBufferGetHeightOfPlane(image, plane),
                    plane, &planeTexture);
                dest.planeTex[plane] = planeTexture;
                if (rc != kCVReturnSuccess || !dest.planeTex[plane]) {
                    static int warned = 0;
                    if (warned++ % 300 == 0)
                        fprintf(stderr, "[VideoDecoder] CVMetalTextureCacheCreateTextureFromImage failed: %d\n", (int)rc);
                    ok = false;
                }
            }
            if (ok) {
                dest.pixelBuffer = CVPixelBufferRetain(image);
                dest.nv12 = true;
                dest.pixels.clear();
            } else {
                dest.releaseGpu();
            }
        } else {
            ok = copyPixelBufferBGRA(image, w, h, dest.pixels);
            dest.nv12 = false;
            dest.pixelFormat = PixelFormat::BGRA8;
        }
        CFRelease(sample);
        if (!ok) return false;

        dest.width = w;
        dest.height = h;
        dest.codedWidth = dest.codedHeight = 0;
        dest.timestamp = ts;
        dest.ycocg = false;
        m_decodedFrames.fetch_add(1);
        return true;
    }
    return false;
}

bool VideoDecoder::readOneFrame(VideoFrame& dest) {
    @autoreleasepool {
        if (m_mode == Mode::Hap) return readHapFrame(dest);
        return readDecodedFrame(dest);
    }
}

// --- Render thread ---------------------------------------------------------

const VideoFrame* VideoDecoder::getFrameAtTime(double timeSeconds, uint64_t currentFrameFence) {
    timeSeconds = std::max(0.0, timeSeconds);
    if (m_duration > 0 && timeSeconds >= m_duration)
        timeSeconds = m_duration - m_frameDuration;

    double prev = m_targetTime.exchange(timeSeconds);
    bool timeChanged = std::abs(timeSeconds - prev) > 0.0005;

    if (timeChanged && m_display.timestamp >= 0) {
        double delta = timeSeconds - m_display.timestamp;
        // Half a frame back, not a whole one: a single-frame step lands
        // exactly on -frameDuration, and the frame it asks for has already
        // been recycled, so a strict comparison leaves the picture unchanged.
        if (delta < -m_frameDuration * 0.5 || delta > 5.0) {
            std::lock_guard<std::mutex> lk(m_seekMu);
            if (!m_seekRequested) {
                if (m_verbose) printf("[VD:get] SEEK t=%.3f disp=%.3f\n", timeSeconds, m_display.timestamp);
                m_seekJustHappened.store(true);
                m_seekRequested = true;
                m_seekTime = timeSeconds;
                m_seekCv.notify_one();
            }
        }
    }

    bool returned = false;
    {
        std::lock_guard<std::mutex> lk(m_dealerMu);

        int bestIdx = -1;
        for (int i = 0; i < (int)m_readable.size(); i++) {
            if (m_readable[i].timestamp <= timeSeconds + m_frameDuration * 0.5) {
                bestIdx = i;
            }
        }

        // A time before the stream's first frame matched nothing. Files
        // whose first PTS is not zero therefore never produced a thumbnail at
        // t=0 and played black until that PTS. When the earliest frame we
        // hold is the closest thing to what was asked for, show it.
        if (bestIdx < 0 && !m_readable.empty()) {
            double firstTs = m_readable.front().timestamp;
            if (firstTs > timeSeconds && firstTs - timeSeconds <= 1.0 &&
                (m_display.width == 0 || m_display.timestamp > firstTs)) {
                bestIdx = 0;
            }
        }

        if (bestIdx >= 0 && m_display.width > 0) {
            double bestTs = m_readable[bestIdx].timestamp;
            double dispTs = m_display.timestamp;
            double bestDist = std::abs(timeSeconds - bestTs);
            double dispDist = std::abs(timeSeconds - dispTs);
            if (bestDist >= dispDist && bestTs != dispTs) {
                while (!m_readable.empty() && m_readable.front().timestamp < dispTs) {
                    m_writeable.push_back(std::move(m_readable.front()));
                    m_readable.pop_front();
                    returned = true;
                }
                bestIdx = -1;
            }
        }

        if (bestIdx >= 0) {
            if (!m_seekJustHappened.exchange(false)) {
                double prevTs = m_display.timestamp;
                double newTs = m_readable[bestIdx].timestamp;
                if (prevTs >= 0 && newTs > prevTs) {
                    double gap = newTs - prevTs;
                    if (gap > m_frameDuration * 2.5) {
                        int skipped = (int)(gap / m_frameDuration) - 1;
                        if (skipped > 0) m_playbackDrops.fetch_add(skipped);
                    }
                }
            }

            if (m_display.width > 0) {
                // The frame leaving the screen may still be referenced by the
                // command buffer being built, so record the timeline value
                // that will retire it. The decode thread waits on this before
                // writing into the frame again.
                m_display.releaseFenceValue = currentFrameFence;
                m_writeable.push_back(std::move(m_display));
                returned = true;
            }
            m_display = std::move(m_readable[bestIdx]);
            m_readable.erase(m_readable.begin() + bestIdx);
            m_displayedFrames.fetch_add(1);

            while (!m_readable.empty() && m_readable.front().timestamp < m_display.timestamp) {
                m_writeable.push_back(std::move(m_readable.front()));
                m_readable.pop_front();
                returned = true;
            }

            if (m_verbose) printf("[VD:get] DISPLAY t=%.3f readable=%d writeable=%d\n",
                m_display.timestamp, (int)m_readable.size(), (int)m_writeable.size());
        }
    }

    // Waking the decode thread on returned frames is what lets it block on a
    // condition variable instead of polling m_writeable.
    if (returned) m_writeableCv.notify_one();
    if (timeChanged) m_seekCv.notify_one();

    if (m_display.width > 0) return &m_display;
    return nullptr;
}

uint64_t VideoDecoder::completedFrameValue() const {
    if (!m_sync.frameEvent) return 0;
    return objc<id<MTLSharedEvent>>(m_sync.frameEvent).signaledValue;
}

// Take a frame out of the writeable pool, waiting until one is returned.
// The pool is bounded, so seeks must borrow instead of allocating.
bool VideoDecoder::borrowFrame(VideoFrame& out) {
    std::unique_lock<std::mutex> lk(m_dealerMu);
    auto available = [this] {
        const uint64_t completed = completedFrameValue();
        return std::find_if(m_writeable.begin(), m_writeable.end(), [completed](const VideoFrame& f) {
            return f.releaseFenceValue == 0 || completed >= f.releaseFenceValue;
        });
    };
    // Poll retirement on this worker rather than blocking the GPU: the frame
    // App is still recording cannot be waited for from here.
    m_writeableCv.wait_for(lk, std::chrono::milliseconds(5),
        [&] { return !m_running || available() != m_writeable.end(); });
    if (!m_running) return false;
    auto it = available();
    if (it == m_writeable.end()) return false;
    out = std::move(*it);
    m_writeable.erase(it);
    out.releaseFenceValue = 0;
    return true;
}

void VideoDecoder::recycle(VideoFrame&& f) {
    std::lock_guard<std::mutex> lk(m_dealerMu);
    m_writeable.push_back(std::move(f));
}

// --- Background decode thread ----------------------------------------------

void VideoDecoder::decodeThread() {
    if (!createReader(0.0)) {
        fprintf(stderr, "[VideoDecoder] decode thread could not open a reader\n");
    }

    bool eof = false;

    // Seek: a new reader positioned at the target, then read until the first
    // frame at or after it. Shared by the explicit seek and the catch-up.
    auto seekTo = [&](double target) {
        if (!createReader(target)) { eof = true; return; }
        m_seekCount.fetch_add(1);
        eof = false;

        {
            std::lock_guard<std::mutex> dlk(m_dealerMu);
            while (!m_readable.empty()) {
                m_writeable.push_back(std::move(m_readable.back()));
                m_readable.pop_back();
            }
        }

        // Borrow from the pool rather than allocating: an allocated frame
        // ends up circulating in the pool forever.
        VideoFrame temp;
        if (!borrowFrame(temp)) return;
        bool placed = false;
        for (int i = 0; i < 300 && m_running; i++) {
            if (!readOneFrame(temp)) { eof = true; break; }
            if (temp.timestamp >= target - m_frameDuration * 0.5) {
                std::lock_guard<std::mutex> dlk(m_dealerMu);
                m_readable.push_back(std::move(temp));
                placed = true;
                break;
            }
        }
        if (!placed) recycle(std::move(temp));
    };

    while (m_running) {
        // Handle seek
        {
            std::unique_lock<std::mutex> lk(m_seekMu);
            if (m_seekRequested) {
                m_seekRequested = false;
                double seekT = m_seekTime;
                lk.unlock();
                if (m_verbose) printf("[VD:dec] SEEK to %.3f\n", seekT);
                seekTo(seekT);
                continue;
            }
        }

        if (eof) {
            std::unique_lock<std::mutex> lk(m_seekMu);
            m_seekCv.wait_for(lk, std::chrono::milliseconds(50));
            continue;
        }

        // Borrow a writeable frame, blocking on the pool's condition variable
        // rather than spinning while it is full.
        VideoFrame frame;
        if (!borrowFrame(frame)) continue;

        // Decode
        auto decStart = std::chrono::steady_clock::now();
        bool decoded = readOneFrame(frame);
        {
            double ms = std::chrono::duration<double, std::milli>(
                std::chrono::steady_clock::now() - decStart).count();
            // Exponential moving average so the perf graph has a real signal
            double prevMs = m_decodeMs.load();
            m_decodeMs.store(prevMs <= 0.0 ? ms : prevMs * 0.9 + ms * 0.1);
        }
        if (!decoded) {
            eof = true;
            if (m_verbose) printf("[VD:dec] EOF\n");
            std::lock_guard<std::mutex> lk(m_dealerMu);
            m_writeable.push_back(std::move(frame));
            continue;
        }

        double target = m_targetTime.load();
        if (m_verbose) printf("[VD:dec] DECODED t=%.3f target=%.3f\n", frame.timestamp, target);

        // If far behind, seek to catch up
        if (frame.timestamp < target - 0.5) {
            if (m_verbose) printf("[VD:dec] CATCHUP SEEK: frame=%.3f target=%.3f\n", frame.timestamp, target);
            recycle(std::move(frame));
            seekTo(target);
            continue;
        }

        // Publish to readable
        {
            std::lock_guard<std::mutex> lk(m_dealerMu);
            auto it = m_readable.begin();
            while (it != m_readable.end() && it->timestamp < frame.timestamp) ++it;
            m_readable.insert(it, std::move(frame));
        }
    }

    destroyReader();
}
