#pragma once
// Audio playback for video clips via AVFoundation + AudioQueue.
//
// Opens the audio track of a video file with an AVAssetReader, decodes to
// float PCM, and plays through an output AudioQueue. Supports seek and
// play/pause synced to the timeline clock. The queue's own sample clock says
// what the device has actually rendered, which is what drift is measured
// against.

#include "objc_ref.h"

#include <AudioToolbox/AudioToolbox.h>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

class AudioPlayer {
public:
    ~AudioPlayer();

    bool open(const std::string& filePath);
    void close();

    // Playback control (called from render thread)
    void play();
    void pause();
    void seek(double timeSeconds);

    bool isOpen() const { return m_openFlag; }
    bool isPlaying() const { return m_playing.load(); }
    // Position actually rendered by the device, not the decoder's read-ahead.
    double currentTime() const;
    // True once the stream ran out. Without it the render loop re-issued
    // play() on every frame after the end of a clip.
    bool atEnd() const { return m_eof.load(); }

    // Audio properties
    uint32_t sampleRate() const { return m_sampleRate; }
    uint32_t channels() const { return m_channels; }

private:
    static constexpr int BUFFER_COUNT = 3;
    static constexpr uint32_t BUFFER_FRAMES = 4096;

    void audioThread();
    bool createReader(double startSeconds);
    void destroyReader();
    bool initQueue();
    bool readAudioSamples(uint8_t* dest, uint32_t framesToRead, uint32_t& framesRead);
    static void bufferReturned(void* user, AudioQueueRef queue, AudioQueueBufferRef buffer);

    // Source
    ObjcRef m_asset;    // AVURLAsset*
    ObjcRef m_track;    // AVAssetTrack*
    ObjcRef m_reader;   // AVAssetReader*
    ObjcRef m_output;   // AVAssetReaderTrackOutput*
    uint32_t m_sampleRate = 0;
    uint32_t m_channels = 0;
    double m_duration = 0;
    bool m_openFlag = false;

    // Output queue
    AudioQueueRef m_queue = nullptr;
    AudioQueueBufferRef m_buffers[BUFFER_COUNT] = {};
    std::mutex m_bufMu;
    std::condition_variable m_bufCv;
    std::vector<AudioQueueBufferRef> m_freeBuffers;   // returned by the queue, ready to fill
    // Stream position at the last queue stop. The queue's sample time counts
    // from zero after a stop, so the played position is this plus the clock.
    std::atomic<double> m_clockBase{0.0};
    std::atomic<bool> m_queueRunning{false};

    // Playback thread
    std::thread m_thread;
    std::atomic<bool> m_running{false};
    std::atomic<bool> m_playing{false};
    std::atomic<bool> m_eof{false};
    std::atomic<double> m_currentTime{0.0};

    // Seek
    std::mutex m_seekMu;
    bool m_seekRequested = false;
    double m_seekTime = 0.0;

    // Leftover sample buffer (partial reads)
    std::vector<uint8_t> m_residual;
    size_t m_residualOffset = 0;
};
