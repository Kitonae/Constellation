#pragma once
// Audio playback for video clips via WASAPI + Media Foundation.
//
// Opens the audio stream of a video file using MF Source Reader,
// decodes to PCM, and plays through WASAPI shared mode.
// Supports seek and play/pause synced to the timeline clock.

#include <d3d12.h>
#include <wrl/client.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <string>
#include <vector>
#include <thread>
#include <mutex>
#include <atomic>
#include <cstdint>

using Microsoft::WRL::ComPtr;

class AudioPlayer {
public:
    ~AudioPlayer();

    bool open(const std::string& filePath);
    void close();

    // Playback control (called from render thread)
    void play();
    void pause();
    void seek(double timeSeconds);

    bool isOpen() const { return m_reader != nullptr; }
    bool isPlaying() const { return m_playing.load(); }
    double currentTime() const { return m_currentTime.load(); }

    // Audio properties
    uint32_t sampleRate() const { return m_sampleRate; }
    uint32_t channels() const { return m_channels; }

private:
    void audioThread();
    bool initWASAPI();
    bool readAudioSamples(uint8_t* dest, uint32_t framesToRead, uint32_t& framesRead);

    // MF Source Reader (audio only)
    ComPtr<IMFSourceReader> m_reader;
    uint32_t m_sampleRate = 0;
    uint32_t m_channels = 0;
    uint32_t m_bitsPerSample = 16;
    double m_duration = 0;

    // WASAPI
    ComPtr<IMMDeviceEnumerator> m_enumerator;
    ComPtr<IMMDevice> m_device;
    ComPtr<IAudioClient> m_audioClient;
    ComPtr<IAudioRenderClient> m_renderClient;
    uint32_t m_bufferFrames = 0;
    HANDLE m_audioEvent = nullptr;

    // Playback thread
    std::thread m_thread;
    std::atomic<bool> m_running{false};
    std::atomic<bool> m_playing{false};
    std::atomic<double> m_currentTime{0.0};

    // Seek
    std::mutex m_seekMu;
    bool m_seekRequested = false;
    double m_seekTime = 0.0;

    // Leftover sample buffer (partial reads from MF)
    std::vector<uint8_t> m_residual;
    size_t m_residualOffset = 0;
};
