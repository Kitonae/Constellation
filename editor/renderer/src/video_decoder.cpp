#define NOMINMAX
#include "video_decoder.h"
#include <mferror.h>
#include <propvarutil.h>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <cmath>

#pragma comment(lib, "propsys.lib")
#pragma comment(lib, "d3d11.lib")

VideoDecoder::~VideoDecoder() { close(); }

// --- DXVA initialization ---

bool VideoDecoder::initDXVA(IDXGIAdapter1* adapter) {
    // Create D3D11 device on the same adapter as the DX12 device
    UINT flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
#ifdef _DEBUG
    flags |= D3D11_CREATE_DEVICE_DEBUG;
#endif
    D3D_FEATURE_LEVEL featureLevel;
    HRESULT hr = D3D11CreateDevice(
        adapter, adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
        nullptr, flags, nullptr, 0, D3D11_SDK_VERSION,
        &m_d3d11Device, &featureLevel, &m_d3d11Ctx);
    if (FAILED(hr)) {
        printf("[VideoDecoder] D3D11 device creation failed: 0x%08x\n", hr);
        return false;
    }

    // Enable multi-threaded access (MF decode thread + our read thread)
    ComPtr<ID3D10Multithread> mt;
    if (SUCCEEDED(m_d3d11Device.As(&mt))) {
        mt->SetMultithreadProtected(TRUE);
    }

    // Create DXGI Device Manager for MF
    UINT resetToken = 0;
    hr = MFCreateDXGIDeviceManager(&resetToken, &m_dxgiManager);
    if (FAILED(hr)) {
        printf("[VideoDecoder] MFCreateDXGIDeviceManager failed: 0x%08x\n", hr);
        return false;
    }
    hr = m_dxgiManager->ResetDevice(m_d3d11Device.Get(), resetToken);
    if (FAILED(hr)) {
        printf("[VideoDecoder] ResetDevice failed: 0x%08x\n", hr);
        return false;
    }

    printf("[VideoDecoder] DXVA: D3D11 device ready (feature level 0x%x)\n", featureLevel);
    return true;
}

// --- Open / Close ---

bool VideoDecoder::open(const std::string& filePath,
                        ID3D11Device* sharedDevice,
                        IMFDXGIDeviceManager* sharedManager) {
    close();

    int wlen = MultiByteToWideChar(CP_UTF8, 0, filePath.c_str(), -1, nullptr, 0);
    std::vector<wchar_t> wpath(wlen);
    MultiByteToWideChar(CP_UTF8, 0, filePath.c_str(), -1, wpath.data(), wlen);

    // Use shared DXVA resources if provided, otherwise create our own
    bool dxvaOk = false;
    if (sharedDevice && sharedManager) {
        m_d3d11Device = sharedDevice;
        sharedDevice->GetImmediateContext(&m_d3d11Ctx);
        m_dxgiManager = sharedManager;
        m_ownsD3D11 = false;
        dxvaOk = true;
        printf("[VideoDecoder] Using shared D3D11 device for DXVA\n");
    } else {
        dxvaOk = initDXVA(nullptr);
        m_ownsD3D11 = dxvaOk;
    }

    ComPtr<IMFAttributes> attrs;
    MFCreateAttributes(&attrs, 4);

    if (dxvaOk) {
        // DXVA path: provide D3D device manager to Source Reader
        attrs->SetUnknown(MF_SOURCE_READER_D3D_MANAGER, m_dxgiManager.Get());
        attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
        attrs->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);
    } else {
        // Software fallback
        attrs->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
    }

    HRESULT hr = MFCreateSourceReaderFromURL(wpath.data(), attrs.Get(), &m_reader);
    if (FAILED(hr)) {
        fprintf(stderr, "[VideoDecoder] Failed to open %s: 0x%08x\n", filePath.c_str(), hr);
        return false;
    }

    m_dxvaActive = dxvaOk;

    if (!configureDecoder()) {
        // If DXVA config failed, retry with software
        if (m_dxvaActive) {
            printf("[VideoDecoder] DXVA config failed, falling back to software decode\n");
            m_reader.Reset();
            m_dxvaActive = false;
            m_dxgiManager.Reset();
            m_d3d11Device.Reset();
            m_d3d11Ctx.Reset();

            ComPtr<IMFAttributes> swAttrs;
            MFCreateAttributes(&swAttrs, 1);
            swAttrs->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);

            hr = MFCreateSourceReaderFromURL(wpath.data(), swAttrs.Get(), &m_reader);
            if (FAILED(hr)) return false;
            if (!configureDecoder()) { close(); return false; }
        } else {
            close();
            return false;
        }
    }

    m_frameDuration = (m_fps > 0) ? (1.0 / m_fps) : (1.0 / 30.0);

    size_t sz = (size_t)m_width * m_height * 4;
    for (int i = 0; i < POOL_SIZE; i++) {
        VideoFrame f;
        f.pixels.resize(sz);
        m_writeable.push_back(std::move(f));
    }

    m_running = true;
    m_targetTime = 0.0;
    m_thread = std::thread(&VideoDecoder::decodeThread, this);

    printf("[VideoDecoder] Opened %s (%ux%u, %.1f fps, %.1fs, %s)\n",
        filePath.c_str(), m_width, m_height, m_fps, m_duration,
        m_dxvaActive ? "DXVA" : "SOFTWARE");
    return true;
}

void VideoDecoder::close() {
    if (m_running) {
        m_running = false;
        m_seekCv.notify_all();
        if (m_thread.joinable()) m_thread.join();
    }
    m_reader.Reset();
    m_staging.Reset();
    if (m_ownsD3D11) {
        m_dxgiManager.Reset();
        m_d3d11Ctx.Reset();
        m_d3d11Device.Reset();
    } else {
        m_dxgiManager = nullptr;
        m_d3d11Ctx = nullptr;
        m_d3d11Device = nullptr;
    }
    m_ownsD3D11 = false;
    m_dxvaActive = false;
    m_writeable.clear();
    m_readable.clear();
    m_display = {};
    m_width = m_height = 0;
    m_duration = 0; m_fps = 30.0;
}

// --- Configure decoder ---

bool VideoDecoder::configureDecoder() {
    ComPtr<IMFMediaType> nativeType;
    HRESULT hr = m_reader->GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &nativeType);
    if (FAILED(hr)) return false;

    UINT64 frameSize = 0;
    nativeType->GetUINT64(MF_MT_FRAME_SIZE, &frameSize);
    m_width = (UINT32)(frameSize >> 32);
    m_height = (UINT32)(frameSize & 0xFFFFFFFF);

    UINT64 frameRate = 0;
    if (SUCCEEDED(nativeType->GetUINT64(MF_MT_FRAME_RATE, &frameRate))) {
        UINT32 num = (UINT32)(frameRate >> 32);
        UINT32 den = (UINT32)(frameRate & 0xFFFFFFFF);
        if (den > 0) m_fps = (double)num / den;
    }

    PROPVARIANT var; PropVariantInit(&var);
    if (SUCCEEDED(m_reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &var))) {
        LONGLONG d = 0; PropVariantToInt64(var, &d);
        m_duration = (double)d / 10000000.0;
    }
    PropVariantClear(&var);

    // Set output format — RGB32 (BGRA) so MF handles color conversion
    ComPtr<IMFMediaType> outputType;
    MFCreateMediaType(&outputType);
    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
    outputType->SetUINT64(MF_MT_FRAME_SIZE, ((UINT64)m_width << 32) | m_height);

    hr = m_reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, outputType.Get());
    if (FAILED(hr)) {
        fprintf(stderr, "[VideoDecoder] Failed to set RGB32 output: 0x%08x\n", hr);
        return false;
    }

    m_reader->SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM, FALSE);
    return m_width > 0 && m_height > 0;
}

int VideoDecoder::readableCount() const {
    std::lock_guard<std::mutex> lk(m_dealerMu);
    return (int)m_readable.size();
}

// ---- Render thread ----

const VideoFrame* VideoDecoder::getFrameAtTime(double timeSeconds) {
    timeSeconds = std::max(0.0, timeSeconds);
    if (m_duration > 0 && timeSeconds >= m_duration)
        timeSeconds = m_duration - m_frameDuration;

    double prev = m_targetTime.exchange(timeSeconds);
    bool timeChanged = std::abs(timeSeconds - prev) > 0.0005;

    if (timeChanged && m_display.timestamp >= 0) {
        double delta = timeSeconds - m_display.timestamp;
        if (delta < -m_frameDuration || delta > 5.0) {
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

    {
        std::lock_guard<std::mutex> lk(m_dealerMu);

        int bestIdx = -1;
        for (int i = 0; i < (int)m_readable.size(); i++) {
            if (m_readable[i].timestamp <= timeSeconds + m_frameDuration * 0.5) {
                bestIdx = i;
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
                m_writeable.push_back(std::move(m_display));
            }
            m_display = std::move(m_readable[bestIdx]);
            m_readable.erase(m_readable.begin() + bestIdx);
            m_displayedFrames.fetch_add(1);

            while (!m_readable.empty() && m_readable.front().timestamp < m_display.timestamp) {
                m_writeable.push_back(std::move(m_readable.front()));
                m_readable.pop_front();
            }

            if (m_verbose) printf("[VD:get] DISPLAY t=%.3f readable=%d writeable=%d\n",
                m_display.timestamp, (int)m_readable.size(), (int)m_writeable.size());
        }
    }

    if (timeChanged) m_seekCv.notify_one();
    return m_display.width > 0 ? &m_display : nullptr;
}

// ---- Background decode thread ----

void VideoDecoder::decodeThread() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    {
        PROPVARIANT p; PropVariantInit(&p);
        p.vt = VT_I8; p.hVal.QuadPart = 0;
        m_reader->SetCurrentPosition(GUID_NULL, p);
        PropVariantClear(&p);
    }

    bool eof = false;

    while (m_running) {
        // Handle seek
        {
            std::unique_lock<std::mutex> lk(m_seekMu);
            if (m_seekRequested) {
                m_seekRequested = false;
                double seekT = m_seekTime;
                lk.unlock();

                if (m_verbose) printf("[VD:dec] SEEK to %.3f\n", seekT);

                LONGLONG posHns = (LONGLONG)(seekT * 10000000.0);
                PROPVARIANT p; PropVariantInit(&p);
                p.vt = VT_I8; p.hVal.QuadPart = posHns;
                m_reader->SetCurrentPosition(GUID_NULL, p);
                PropVariantClear(&p);
                m_seekCount.fetch_add(1);
                eof = false;

                {
                    std::lock_guard<std::mutex> dlk(m_dealerMu);
                    while (!m_readable.empty()) {
                        m_writeable.push_back(std::move(m_readable.back()));
                        m_readable.pop_back();
                    }
                }

                VideoFrame temp;
                temp.pixels.resize((size_t)m_width * m_height * 4);
                for (int i = 0; i < 300 && m_running; i++) {
                    if (!readOneFrame(temp)) { eof = true; break; }
                    if (temp.timestamp >= seekT - m_frameDuration * 0.5) {
                        std::lock_guard<std::mutex> dlk(m_dealerMu);
                        m_readable.push_back(std::move(temp));
                        break;
                    }
                }
                continue;
            }
        }

        if (eof) {
            std::unique_lock<std::mutex> lk(m_seekMu);
            m_seekCv.wait_for(lk, std::chrono::milliseconds(50));
            continue;
        }

        // Borrow writeable frame
        VideoFrame frame;
        bool haveFrame = false;
        {
            std::lock_guard<std::mutex> lk(m_dealerMu);
            if (!m_writeable.empty()) {
                frame = std::move(m_writeable.back());
                m_writeable.pop_back();
                haveFrame = true;
            }
        }

        if (!haveFrame) {
            std::unique_lock<std::mutex> lk(m_seekMu);
            m_seekCv.wait_for(lk, std::chrono::milliseconds(2));
            continue;
        }

        // Decode
        if (!readOneFrame(frame)) {
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

            {
                std::lock_guard<std::mutex> lk(m_dealerMu);
                m_writeable.push_back(std::move(frame));
                while (!m_readable.empty()) {
                    m_writeable.push_back(std::move(m_readable.back()));
                    m_readable.pop_back();
                }
            }

            LONGLONG posHns = (LONGLONG)(target * 10000000.0);
            PROPVARIANT p; PropVariantInit(&p);
            p.vt = VT_I8; p.hVal.QuadPart = posHns;
            m_reader->SetCurrentPosition(GUID_NULL, p);
            PropVariantClear(&p);
            m_seekCount.fetch_add(1);

            VideoFrame temp;
            temp.pixels.resize((size_t)m_width * m_height * 4);
            for (int i = 0; i < 300 && m_running; i++) {
                if (!readOneFrame(temp)) { eof = true; break; }
                if (temp.timestamp >= target - m_frameDuration * 0.5) {
                    std::lock_guard<std::mutex> dlk(m_dealerMu);
                    m_readable.push_back(std::move(temp));
                    break;
                }
            }
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

    CoUninitialize();
}

// ---- Read one frame (works for both DXVA and software paths) ----

bool VideoDecoder::readOneFrame(VideoFrame& dest) {
    DWORD streamIndex = 0, flags = 0;
    LONGLONG timestamp = 0;
    ComPtr<IMFSample> sample;

    HRESULT hr = m_reader->ReadSample(
        MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0,
        &streamIndex, &flags, &timestamp, &sample);
    if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) return false;
    if (!sample) return false;

    ComPtr<IMFMediaBuffer> buffer;
    hr = sample->ConvertToContiguousBuffer(&buffer);
    if (FAILED(hr)) return false;

    // Try IMFDXGIBuffer first (DXVA path — frame is on GPU)
    ComPtr<IMFDXGIBuffer> dxgiBuf;
    if (m_dxvaActive && SUCCEEDED(buffer->QueryInterface(IID_PPV_ARGS(&dxgiBuf)))) {
        ComPtr<ID3D11Texture2D> tex;
        UINT subIdx = 0;
        hr = dxgiBuf->GetResource(IID_PPV_ARGS(&tex));
        if (FAILED(hr)) return false;
        dxgiBuf->GetSubresourceIndex(&subIdx);

        D3D11_TEXTURE2D_DESC desc;
        tex->GetDesc(&desc);

        // Create or reuse staging texture for CPU readback
        if (!m_staging) {
            D3D11_TEXTURE2D_DESC stagingDesc = desc;
            stagingDesc.Usage = D3D11_USAGE_STAGING;
            stagingDesc.BindFlags = 0;
            stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            stagingDesc.MiscFlags = 0;
            stagingDesc.ArraySize = 1;
            hr = m_d3d11Device->CreateTexture2D(&stagingDesc, nullptr, &m_staging);
            if (FAILED(hr)) return false;
        }

        // Copy from GPU texture to staging
        m_d3d11Ctx->CopySubresourceRegion(m_staging.Get(), 0, 0, 0, 0, tex.Get(), subIdx, nullptr);

        D3D11_MAPPED_SUBRESOURCE mapped;
        hr = m_d3d11Ctx->Map(m_staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
        if (FAILED(hr)) return false;

        uint32_t rowBytes = m_width * 4;
        dest.width = m_width;
        dest.height = m_height;
        dest.timestamp = (double)timestamp / 10000000.0;
        if (dest.pixels.size() != (size_t)rowBytes * m_height)
            dest.pixels.resize((size_t)rowBytes * m_height);
        m_decodedFrames.fetch_add(1);

        // Copy rows (staging may have different pitch)
        for (uint32_t y = 0; y < m_height; y++) {
            memcpy(dest.pixels.data() + y * rowBytes,
                   (const uint8_t*)mapped.pData + y * mapped.RowPitch,
                   rowBytes);
        }

        m_d3d11Ctx->Unmap(m_staging.Get(), 0);

        // Force alpha opaque
        uint32_t* px = (uint32_t*)dest.pixels.data();
        size_t count = (size_t)m_width * m_height;
        for (size_t i = 0; i < count; i++) px[i] |= 0xFF000000;

        return true;
    }

    // Software path — lock buffer directly
    ComPtr<IMF2DBuffer> buffer2d;
    LONG stride = 0;
    if (SUCCEEDED(buffer->QueryInterface(IID_PPV_ARGS(&buffer2d)))) {
        BYTE* s = nullptr; buffer2d->Lock2D(&s, &stride); buffer2d->Unlock2D();
    }
    if (stride == 0) stride = (LONG)(m_width * 4);

    BYTE* data = nullptr; DWORD maxLen = 0, curLen = 0;
    hr = buffer->Lock(&data, &maxLen, &curLen);
    if (FAILED(hr) || !data) return false;

    uint32_t rowBytes = m_width * 4;
    dest.width = m_width;
    dest.height = m_height;
    dest.timestamp = (double)timestamp / 10000000.0;
    if (dest.pixels.size() != (size_t)rowBytes * m_height)
        dest.pixels.resize((size_t)rowBytes * m_height);
    m_decodedFrames.fetch_add(1);

    LONG absStride = std::abs(stride);
    bool bottomUp = (stride < 0);
    const BYTE* start = bottomUp ? (data + (m_height - 1) * absStride) : data;
    LONG rowStep = bottomUp ? -(LONG)absStride : (LONG)absStride;

    if (!bottomUp && absStride == (LONG)rowBytes) {
        memcpy(dest.pixels.data(), data, (size_t)rowBytes * m_height);
    } else {
        for (uint32_t y = 0; y < m_height; y++)
            memcpy(dest.pixels.data() + y * rowBytes, start + y * rowStep, rowBytes);
    }

    uint32_t* px = (uint32_t*)dest.pixels.data();
    size_t count = (size_t)m_width * m_height;
    for (size_t i = 0; i < count; i++) px[i] |= 0xFF000000;

    buffer->Unlock();
    return true;
}
