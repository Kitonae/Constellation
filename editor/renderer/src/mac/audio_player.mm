#include "audio_player.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>

AudioPlayer::~AudioPlayer() { close(); }

bool AudioPlayer::open(const std::string& filePath) {
    close();

    @autoreleasepool {
        NSURL* url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:filePath.c_str()]];
        AVURLAsset* asset = [AVURLAsset URLAssetWithURL:url
            options:@{ AVURLAssetPreferPreciseDurationAndTimingKey: @YES }];
        if (!asset) return false;

        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        __block NSArray<AVAssetTrack*>* tracks = nil;
        [asset loadTracksWithMediaType:AVMediaTypeAudio
                     completionHandler:^(NSArray<AVAssetTrack*>* t, NSError*) {
            tracks = t;
            dispatch_semaphore_signal(sem);
        }];
        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
        if (tracks.count == 0) {
            printf("[Audio] No audio stream in %s\n", filePath.c_str());
            return false;
        }
        AVAssetTrack* track = tracks[0];
        [asset loadValuesAsynchronouslyForKeys:@[@"duration"]
                             completionHandler:^{ dispatch_semaphore_signal(sem); }];
        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
        [track loadValuesAsynchronouslyForKeys:@[@"formatDescriptions"]
                             completionHandler:^{ dispatch_semaphore_signal(sem); }];
        dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);

        NSArray* descs = track.formatDescriptions;
        if (descs.count == 0) return false;
        CMAudioFormatDescriptionRef fd = (__bridge CMAudioFormatDescriptionRef)descs[0];
        const AudioStreamBasicDescription* asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd);
        if (!asbd || asbd->mSampleRate <= 0 || asbd->mChannelsPerFrame == 0) {
            printf("[Audio] Invalid audio format\n");
            return false;
        }
        m_sampleRate = (uint32_t)asbd->mSampleRate;
        m_channels = std::min<uint32_t>(asbd->mChannelsPerFrame, 8);
        CMTime duration = asset.duration;
        m_duration = CMTIME_IS_NUMERIC(duration) ? CMTimeGetSeconds(duration) : 0.0;

        m_asset = retainObjc(asset);
        m_track = retainObjc(track);
    }

    if (!initQueue()) {
        printf("[Audio] AudioQueue init failed\n");
        close();
        return false;
    }

    // Start audio thread
    m_running = true;
    m_playing = false;
    m_thread = std::thread(&AudioPlayer::audioThread, this);
    m_openFlag = true;

    printf("[Audio] Opened %s (%u Hz, %u ch, float, %.1fs)\n",
        filePath.c_str(), m_sampleRate, m_channels, m_duration);
    return true;
}

bool AudioPlayer::createReader(double startSeconds) {
    destroyReader();
    @autoreleasepool {
        AVURLAsset* asset = objc<AVURLAsset*>(m_asset);
        AVAssetTrack* track = objc<AVAssetTrack*>(m_track);
        if (!asset || !track) return false;
        NSError* error = nil;
        AVAssetReader* reader = [AVAssetReader assetReaderWithAsset:asset error:&error];
        if (!reader) return false;
        NSDictionary* settings = @{
            AVFormatIDKey: @(kAudioFormatLinearPCM),
            AVSampleRateKey: @(m_sampleRate),
            AVNumberOfChannelsKey: @(m_channels),
            AVLinearPCMBitDepthKey: @32,
            AVLinearPCMIsFloatKey: @YES,
            AVLinearPCMIsNonInterleaved: @NO,
            AVLinearPCMIsBigEndianKey: @NO,
        };
        AVAssetReaderTrackOutput* output = [AVAssetReaderTrackOutput
            assetReaderTrackOutputWithTrack:track outputSettings:settings];
        if (!output || ![reader canAddOutput:output]) return false;
        output.alwaysCopiesSampleData = NO;
        [reader addOutput:output];
        reader.timeRange = CMTimeRangeMake(CMTimeMakeWithSeconds(std::max(0.0, startSeconds), 600),
                                           kCMTimePositiveInfinity);
        if (![reader startReading]) {
            fprintf(stderr, "[Audio] startReading failed: %s\n",
                reader.error ? reader.error.localizedDescription.UTF8String : "unknown");
            return false;
        }
        m_reader = retainObjc(reader);
        m_output = retainObjc(output);
        return true;
    }
}

void AudioPlayer::destroyReader() {
    @autoreleasepool {
        if (m_reader) {
            AVAssetReader* reader = objc<AVAssetReader*>(m_reader);
            if (reader.status == AVAssetReaderStatusReading) [reader cancelReading];
        }
        m_output.reset();
        m_reader.reset();
    }
}

bool AudioPlayer::initQueue() {
    AudioStreamBasicDescription fmt = {};
    fmt.mSampleRate = m_sampleRate;
    fmt.mFormatID = kAudioFormatLinearPCM;
    fmt.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    fmt.mChannelsPerFrame = m_channels;
    fmt.mBitsPerChannel = 32;
    fmt.mBytesPerFrame = 4 * m_channels;
    fmt.mFramesPerPacket = 1;
    fmt.mBytesPerPacket = fmt.mBytesPerFrame;

    OSStatus st = AudioQueueNewOutput(&fmt, &AudioPlayer::bufferReturned, this, nullptr, nullptr, 0, &m_queue);
    if (st != noErr || !m_queue) {
        printf("[Audio] AudioQueueNewOutput failed: %d\n", (int)st);
        m_queue = nullptr;
        return false;
    }
    for (int i = 0; i < BUFFER_COUNT; i++) {
        st = AudioQueueAllocateBuffer(m_queue, BUFFER_FRAMES * fmt.mBytesPerFrame, &m_buffers[i]);
        if (st != noErr) {
            printf("[Audio] AudioQueueAllocateBuffer failed: %d\n", (int)st);
            return false;
        }
        m_freeBuffers.push_back(m_buffers[i]);
    }
    return true;
}

// AudioQueue's own thread: the buffer has been played and can be refilled.
void AudioPlayer::bufferReturned(void* user, AudioQueueRef, AudioQueueBufferRef buffer) {
    auto* self = static_cast<AudioPlayer*>(user);
    {
        std::lock_guard<std::mutex> lk(self->m_bufMu);
        self->m_freeBuffers.push_back(buffer);
    }
    self->m_bufCv.notify_one();
}

void AudioPlayer::close() {
    m_running = false;
    m_playing = false;
    m_bufCv.notify_all();
    if (m_thread.joinable()) m_thread.join();

    if (m_queue) {
        AudioQueueStop(m_queue, true);
        AudioQueueDispose(m_queue, true);   // frees the buffers too
        m_queue = nullptr;
    }
    for (auto& b : m_buffers) b = nullptr;
    m_freeBuffers.clear();
    m_queueRunning = false;

    destroyReader();
    m_track.reset();
    m_asset.reset();
    m_residual.clear();
    m_residualOffset = 0;
    m_eof.store(false);
    m_clockBase.store(0.0);
    m_currentTime.store(0.0);
    if (m_openFlag) printf("[Audio] Closed\n");
    m_openFlag = false;
    m_sampleRate = m_channels = 0;
}

void AudioPlayer::play() {
    if (!m_queue) return;
    if (m_eof.load()) return;   // caller should seek first
    m_playing = true;
    // Started by the audio thread once buffers are primed, so the queue never
    // starts empty and underruns straight away.
    m_bufCv.notify_one();
}

void AudioPlayer::pause() {
    if (!m_queue) return;
    m_playing = false;
    if (m_queueRunning.exchange(false)) AudioQueuePause(m_queue);
}

double AudioPlayer::currentTime() const {
    // Measure drift against what the device has actually rendered, not against
    // how far the decoder has read ahead.
    if (m_queue && m_sampleRate > 0) {
        AudioTimeStamp ts = {};
        if (AudioQueueGetCurrentTime(m_queue, nullptr, &ts, nullptr) == noErr &&
            (ts.mFlags & kAudioTimeStampSampleTimeValid)) {
            return m_clockBase.load() + std::max(0.0, ts.mSampleTime) / (double)m_sampleRate;
        }
    }
    return m_currentTime.load();
}

void AudioPlayer::seek(double timeSeconds) {
    // Only records the request. The audio thread performs it; doing the work
    // here would block the render thread on the reader rebuild and the
    // queue stop.
    {
        std::lock_guard<std::mutex> lk(m_seekMu);
        m_seekRequested = true;
        m_seekTime = std::max(0.0, timeSeconds);
    }
    m_bufCv.notify_one();
}

bool AudioPlayer::readAudioSamples(uint8_t* dest, uint32_t framesToRead, uint32_t& framesRead) {
    const uint32_t bytesPerFrame = m_channels * 4;
    const uint32_t bytesNeeded = framesToRead * bytesPerFrame;
    uint32_t bytesWritten = 0;

    // Drain residual first
    while (bytesWritten < bytesNeeded && m_residualOffset < m_residual.size()) {
        uint32_t avail = (uint32_t)(m_residual.size() - m_residualOffset);
        uint32_t toCopy = std::min(avail, bytesNeeded - bytesWritten);
        memcpy(dest + bytesWritten, m_residual.data() + m_residualOffset, toCopy);
        m_residualOffset += toCopy;
        bytesWritten += toCopy;
    }
    if (m_residualOffset >= m_residual.size()) {
        m_residual.clear();
        m_residualOffset = 0;
    }

    AVAssetReaderTrackOutput* output = objc<AVAssetReaderTrackOutput*>(m_output);
    while (bytesWritten < bytesNeeded) {
        if (!output) {
            memset(dest + bytesWritten, 0, bytesNeeded - bytesWritten);
            framesRead = framesToRead;
            return false;
        }
        CMSampleBufferRef sample = [output copyNextSampleBuffer];
        if (!sample) {
            // Fill remaining with silence
            memset(dest + bytesWritten, 0, bytesNeeded - bytesWritten);
            framesRead = framesToRead;
            return false; // EOF
        }
        CMTime pts = CMSampleBufferGetOutputPresentationTimeStamp(sample);
        if (CMTIME_IS_NUMERIC(pts)) m_currentTime.store(CMTimeGetSeconds(pts));

        CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
        size_t len = block ? CMBlockBufferGetDataLength(block) : 0;
        if (len == 0) { CFRelease(sample); continue; }

        uint32_t remaining = bytesNeeded - bytesWritten;
        if (len <= remaining) {
            CMBlockBufferCopyDataBytes(block, 0, len, dest + bytesWritten);
            bytesWritten += (uint32_t)len;
        } else {
            CMBlockBufferCopyDataBytes(block, 0, remaining, dest + bytesWritten);
            bytesWritten += remaining;
            // Store leftover
            m_residual.resize(len - remaining);
            CMBlockBufferCopyDataBytes(block, remaining, len - remaining, m_residual.data());
            m_residualOffset = 0;
        }
        CFRelease(sample);
    }

    framesRead = framesToRead;
    return true;
}

void AudioPlayer::audioThread() {
    const uint32_t bytesPerFrame = m_channels * 4;
    if (!createReader(0.0)) {
        fprintf(stderr, "[Audio] no reader; audio thread idle\n");
    }

    while (m_running) {
        // Handle seek: copy the request out under the lock, then do the slow
        // work (reader rebuild, queue stop/reset) unlocked so seek() never
        // blocks the render thread.
        bool doSeek = false;
        double seekTo = 0.0;
        {
            std::lock_guard<std::mutex> lk(m_seekMu);
            if (m_seekRequested) {
                m_seekRequested = false;
                doSeek = true;
                seekTo = m_seekTime;
            }
        }
        if (doSeek) {
            @autoreleasepool {
                // Synchronous stop drops queued buffers and resets the sample
                // clock to zero; every buffer comes back to the free list.
                AudioQueueStop(m_queue, true);
                m_queueRunning = false;
                {
                    std::lock_guard<std::mutex> lk(m_bufMu);
                    m_freeBuffers.clear();
                    for (auto b : m_buffers) if (b) m_freeBuffers.push_back(b);
                }
                createReader(seekTo);
                m_currentTime.store(seekTo);
                m_eof.store(false);
                m_residual.clear();
                m_residualOffset = 0;
                m_clockBase.store(seekTo);
            }
        }

        if (!m_playing) {
            // Idle wait
            std::unique_lock<std::mutex> lk(m_bufMu);
            m_bufCv.wait_for(lk, std::chrono::milliseconds(20));
            continue;
        }

        // Fill every free buffer, then make sure the queue is running.
        AudioQueueBufferRef buffer = nullptr;
        {
            std::unique_lock<std::mutex> lk(m_bufMu);
            if (m_freeBuffers.empty()) {
                m_bufCv.wait_for(lk, std::chrono::milliseconds(10));
                if (m_freeBuffers.empty()) {
                    // Nothing to fill: the queue holds every buffer, so it
                    // must be running to return them.
                    lk.unlock();
                    if (!m_queueRunning.exchange(true)) AudioQueueStart(m_queue, nullptr);
                    continue;
                }
            }
            buffer = m_freeBuffers.back();
            m_freeBuffers.pop_back();
        }

        uint32_t framesRead = 0;
        @autoreleasepool {
            bool ok = readAudioSamples((uint8_t*)buffer->mAudioData, BUFFER_FRAMES, framesRead);
            buffer->mAudioDataByteSize = framesRead * bytesPerFrame;
            AudioQueueEnqueueBuffer(m_queue, buffer, 0, nullptr);
            if (!m_queueRunning.exchange(true)) AudioQueueStart(m_queue, nullptr);
            if (!ok) {
                // EOF: remember it so play() is not re-issued every frame.
                // The silence just queued lets the last real samples play out.
                m_eof.store(true);
                m_playing = false;
            }
        }
    }

    destroyReader();
}
