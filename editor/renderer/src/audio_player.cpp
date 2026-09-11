#define NOMINMAX
#include "audio_player.h"
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <mferror.h>
#include <propvarutil.h>
#include <functiondiscoverykeys_devpkey.h>

#pragma comment(lib, "propsys.lib")

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")

AudioPlayer::~AudioPlayer() { close(); }

bool AudioPlayer::open(const std::string& filePath) {
    close();

    int wlen = MultiByteToWideChar(CP_UTF8, 0, filePath.c_str(), -1, nullptr, 0);
    std::vector<wchar_t> wpath(wlen);
    MultiByteToWideChar(CP_UTF8, 0, filePath.c_str(), -1, wpath.data(), wlen);

    // Create Source Reader for audio only
    ComPtr<IMFAttributes> attrs;
    MFCreateAttributes(&attrs, 1);
    attrs->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, FALSE);

    HRESULT hr = MFCreateSourceReaderFromURL(wpath.data(), attrs.Get(), &m_reader);
    if (FAILED(hr)) {
        printf("[Audio] Failed to open %s: 0x%08x\n", filePath.c_str(), hr);
        return false;
    }

    // Disable video, enable audio
    m_reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
    hr = m_reader->SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM, TRUE);
    if (FAILED(hr)) {
        printf("[Audio] No audio stream in %s\n", filePath.c_str());
        m_reader.Reset();
        return false;
    }

    // Get native audio format to detect sample rate / channels
    ComPtr<IMFMediaType> nativeType;
    hr = m_reader->GetNativeMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, &nativeType);
    if (FAILED(hr)) {
        printf("[Audio] Failed to get native audio type: 0x%08x\n", hr);
        m_reader.Reset();
        return false;
    }

    // Get duration
    PROPVARIANT var;
    PropVariantInit(&var);
    if (SUCCEEDED(m_reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &var))) {
        LONGLONG d = 0;
        PropVariantToInt64(var, &d);
        m_duration = (double)d / 10000000.0;
    }
    PropVariantClear(&var);

    // Set output to PCM float 32-bit (WASAPI friendly)
    ComPtr<IMFMediaType> outputType;
    MFCreateMediaType(&outputType);
    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    outputType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);

    hr = m_reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, outputType.Get());
    if (FAILED(hr)) {
        // Fallback: try PCM 16-bit
        outputType.Reset();
        MFCreateMediaType(&outputType);
        outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        outputType->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_PCM);
        hr = m_reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, outputType.Get());
        if (FAILED(hr)) {
            printf("[Audio] Failed to set audio output format: 0x%08x\n", hr);
            m_reader.Reset();
            return false;
        }
    }

    // Read actual output format
    ComPtr<IMFMediaType> actualType;
    m_reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_AUDIO_STREAM, &actualType);
    if (actualType) {
        actualType->GetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, &m_sampleRate);
        actualType->GetUINT32(MF_MT_AUDIO_NUM_CHANNELS, &m_channels);
        actualType->GetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, &m_bitsPerSample);
    }

    if (m_sampleRate == 0 || m_channels == 0) {
        printf("[Audio] Invalid audio format: %u Hz, %u ch\n", m_sampleRate, m_channels);
        m_reader.Reset();
        return false;
    }

    // Init WASAPI
    if (!initWASAPI()) {
        printf("[Audio] WASAPI init failed\n");
        m_reader.Reset();
        return false;
    }

    // Start audio thread
    m_running = true;
    m_playing = false;
    m_thread = std::thread(&AudioPlayer::audioThread, this);

    printf("[Audio] Opened %s (%u Hz, %u ch, %u bit, %.1fs)\n",
        filePath.c_str(), m_sampleRate, m_channels, m_bitsPerSample, m_duration);
    return true;
}

bool AudioPlayer::initWASAPI() {
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
        CLSCTX_ALL, IID_PPV_ARGS(&m_enumerator));
    if (FAILED(hr)) return false;

    hr = m_enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &m_device);
    if (FAILED(hr)) return false;

    hr = m_device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
        (void**)m_audioClient.GetAddressOf());
    if (FAILED(hr)) return false;

    // Build WAVEFORMATEX matching our decoded audio
    WAVEFORMATEX wfx = {};
    wfx.wFormatTag = (m_bitsPerSample == 32) ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM;
    wfx.nChannels = (WORD)m_channels;
    wfx.nSamplesPerSec = m_sampleRate;
    wfx.wBitsPerSample = (WORD)m_bitsPerSample;
    wfx.nBlockAlign = wfx.nChannels * wfx.wBitsPerSample / 8;
    wfx.nAvgBytesPerSec = wfx.nSamplesPerSec * wfx.nBlockAlign;

    // Try to initialize in shared mode with event-driven buffering
    REFERENCE_TIME bufferDuration = 500000; // 50ms buffer
    hr = m_audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        bufferDuration, 0, &wfx, nullptr);
    if (FAILED(hr)) {
        // Retry without event callback
        hr = m_audioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            bufferDuration, 0, &wfx, nullptr);
        if (FAILED(hr)) {
            printf("[Audio] WASAPI Initialize failed: 0x%08x\n", hr);
            return false;
        }
    }

    m_audioClient->GetBufferSize(&m_bufferFrames);
    hr = m_audioClient->GetService(IID_PPV_ARGS(&m_renderClient));
    if (FAILED(hr)) return false;

    // IAudioClock reports what the device has actually rendered. Reporting the
    // decoder's read-ahead position instead made drift look larger than it was
    // and triggered spurious re-seeks.
    if (SUCCEEDED(m_audioClient->GetService(IID_PPV_ARGS(&m_audioClock)))) {
        m_audioClock->GetFrequency(&m_clockFreq);
    }

    // Create event for buffer notifications
    m_audioEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    m_audioClient->SetEventHandle(m_audioEvent);

    return true;
}

void AudioPlayer::close() {
    m_running = false;
    m_playing = false;
    if (m_thread.joinable()) m_thread.join();

    if (m_audioClient) m_audioClient->Stop();
    m_renderClient.Reset();
    m_audioClock.Reset();
    m_clockFreq = 0;
    m_audioClient.Reset();
    m_device.Reset();
    m_enumerator.Reset();
    if (m_audioEvent) { CloseHandle(m_audioEvent); m_audioEvent = nullptr; }

    m_reader.Reset();
    m_residual.clear();
    m_residualOffset = 0;
    m_eof.store(false);
    m_clockBase.store(0.0);
    m_sampleRate = m_channels = 0;
    printf("[Audio] Closed\n");
}

void AudioPlayer::play() {
    if (!m_audioClient) return;
    if (m_eof.load()) return;   // caller should seek first
    m_playing = true;
    m_audioClient->Start();
}

double AudioPlayer::currentTime() const {
    // Measure drift against what the device has actually rendered, not against
    // how far the decoder has read ahead.
    if (m_audioClock && m_clockFreq) {
        UINT64 pos = 0, qpc = 0;
        if (SUCCEEDED(m_audioClock->GetPosition(&pos, &qpc))) {
            return m_clockBase.load() + (double)pos / (double)m_clockFreq;
        }
    }
    return m_currentTime.load();
}

void AudioPlayer::pause() {
    if (!m_audioClient) return;
    m_playing = false;
    m_audioClient->Stop();
}

void AudioPlayer::seek(double timeSeconds) {
    // Only records the request. The audio thread performs it; doing the work
    // here meant the render thread blocked on the mutex the audio thread holds
    // across SetCurrentPosition and the WASAPI Stop/Reset.
    std::lock_guard<std::mutex> lk(m_seekMu);
    m_seekRequested = true;
    m_seekTime = (std::max)(0.0, timeSeconds);
}

bool AudioPlayer::readAudioSamples(uint8_t* dest, uint32_t framesToRead, uint32_t& framesRead) {
    uint32_t bytesPerFrame = m_channels * m_bitsPerSample / 8;
    uint32_t bytesNeeded = framesToRead * bytesPerFrame;
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

    // Read from MF
    while (bytesWritten < bytesNeeded) {
        DWORD streamIndex = 0, flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;

        HRESULT hr = m_reader->ReadSample(
            MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0,
            &streamIndex, &flags, &timestamp, &sample);

        if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) {
            // Fill remaining with silence
            memset(dest + bytesWritten, 0, bytesNeeded - bytesWritten);
            framesRead = framesToRead;
            return false; // EOF
        }

        if (!sample) continue;

        m_currentTime.store((double)timestamp / 10000000.0);

        ComPtr<IMFMediaBuffer> buffer;
        sample->ConvertToContiguousBuffer(&buffer);
        if (!buffer) continue;

        BYTE* data = nullptr;
        DWORD len = 0;
        buffer->Lock(&data, nullptr, &len);

        uint32_t remaining = bytesNeeded - bytesWritten;
        if (len <= remaining) {
            memcpy(dest + bytesWritten, data, len);
            bytesWritten += len;
        } else {
            memcpy(dest + bytesWritten, data, remaining);
            bytesWritten += remaining;
            // Store leftover
            m_residual.assign(data + remaining, data + len);
            m_residualOffset = 0;
        }

        buffer->Unlock();
    }

    framesRead = framesToRead;
    return true;
}

void AudioPlayer::audioThread() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    uint32_t bytesPerFrame = m_channels * m_bitsPerSample / 8;

    while (m_running) {
        // Handle seek: copy the request out under the lock, then do the
        // slow work (MF SetCurrentPosition, WASAPI Stop/Reset/Start) unlocked
        // so AudioPlayer::seek never blocks the render thread.
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
            LONGLONG pos = (LONGLONG)(seekTo * 10000000.0);
            PROPVARIANT p;
            PropVariantInit(&p);
            p.vt = VT_I8;
            p.hVal.QuadPart = pos;
            m_reader->SetCurrentPosition(GUID_NULL, p);
            PropVariantClear(&p);
            m_currentTime.store(seekTo);
            m_eof.store(false);
            m_residual.clear();
            m_residualOffset = 0;
            if (m_audioClient) {
                m_audioClient->Stop();
                m_audioClient->Reset();   // resets IAudioClock to zero
                m_clockBase.store(seekTo);
                if (m_playing) m_audioClient->Start();
            }
        }

        if (!m_playing) {
            // Idle wait
            if (m_audioEvent) {
                WaitForSingleObject(m_audioEvent, 20);
            } else {
                Sleep(10);
            }
            continue;
        }

        // Get padding (how many frames are already queued)
        UINT32 padding = 0;
        m_audioClient->GetCurrentPadding(&padding);
        UINT32 available = m_bufferFrames - padding;

        if (available == 0) {
            if (m_audioEvent) {
                WaitForSingleObject(m_audioEvent, 10);
            } else {
                Sleep(1);
            }
            continue;
        }

        // Get WASAPI buffer
        BYTE* bufferData = nullptr;
        HRESULT hr = m_renderClient->GetBuffer(available, &bufferData);
        if (FAILED(hr)) {
            Sleep(1);
            continue;
        }

        // Read decoded audio
        uint32_t framesRead = 0;
        bool ok = readAudioSamples(bufferData, available, framesRead);

        m_renderClient->ReleaseBuffer(framesRead, ok ? 0 : AUDCLNT_BUFFERFLAGS_SILENT);

        if (!ok) {
            // EOF — stop and remember it so play() is not re-issued every frame
            m_eof.store(true);
            m_playing = false;
        }
    }

    CoUninitialize();
}
