#define NOMINMAX
#include "video_decoder.h"
#include "video_buffer.h"
#include "decoder_params.h"
#include <mferror.h>
#include <propvarutil.h>
#include <cstdio>
#include <cstring>
#include <algorithm>
#include <chrono>
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

// --- Shared DXGI texture creation ---

bool VideoDecoder::createSharedTexture(VideoFrame& frame) {
    if (!m_d3d12Device || !m_d3d11Device) return false;

    // D3D12 side: create BGRA texture with SHARED heap flag
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = D3D12_HEAP_TYPE_DEFAULT;

    D3D12_RESOURCE_DESC td = {};
    td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    td.Width = m_width;
    td.Height = m_height;
    td.DepthOrArraySize = 1;
    td.MipLevels = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    td.Flags = D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;

    HRESULT hr = m_d3d12Device->CreateCommittedResource(
        &hp, D3D12_HEAP_FLAG_SHARED,
        &td, D3D12_RESOURCE_STATE_COMMON, nullptr,
        IID_PPV_ARGS(&frame.d3d12Texture));
    if (FAILED(hr)) {
        printf("[VideoDecoder] CreateCommittedResource (shared) failed: 0x%08x\n", hr);
        return false;
    }

    // Get NT shared handle
    hr = m_d3d12Device->CreateSharedHandle(
        frame.d3d12Texture.Get(), nullptr, GENERIC_ALL, nullptr, &frame.sharedHandle);
    if (FAILED(hr)) {
        printf("[VideoDecoder] CreateSharedHandle failed: 0x%08x\n", hr);
        frame.d3d12Texture.Reset();
        return false;
    }

    // Open on D3D11 side
    ComPtr<ID3D11Device1> dev1;
    hr = m_d3d11Device.As(&dev1);
    if (FAILED(hr)) {
        printf("[VideoDecoder] ID3D11Device1 QI failed: 0x%08x\n", hr);
        CloseHandle(frame.sharedHandle);
        frame.sharedHandle = nullptr;
        frame.d3d12Texture.Reset();
        return false;
    }

    hr = dev1->OpenSharedResource1(frame.sharedHandle, IID_PPV_ARGS(&frame.d3d11Shared));
    if (FAILED(hr)) {
        printf("[VideoDecoder] OpenSharedResource1 failed: 0x%08x\n", hr);
        CloseHandle(frame.sharedHandle);
        frame.sharedHandle = nullptr;
        frame.d3d12Texture.Reset();
        return false;
    }

    frame.width = m_width;
    frame.height = m_height;
    return true;
}

// --- Open / Close ---

bool VideoDecoder::open(const std::string& filePath,
                        ID3D12Device* d3d12Device,
                        ID3D11Device* sharedDevice,
                        IMFDXGIDeviceManager* sharedManager,
                        ID3D11On12Device2* d3d11On12Device,
                        ID3D12CommandQueue* d3d12Queue,
                        bool nv12Mode, const DecoderSync& sync) {
    close();
    m_sync = sync;

    m_d3d12Device = d3d12Device;
    m_d3d12Queue = d3d12Queue;
    m_d3d11On12 = d3d11On12Device;
    m_sharesRenderQueue = (d3d11On12Device != nullptr);

    int wlen = MultiByteToWideChar(CP_UTF8, 0, filePath.c_str(), -1, nullptr, 0);
    std::vector<wchar_t> wbuf(wlen);
    MultiByteToWideChar(CP_UTF8, 0, filePath.c_str(), -1, wbuf.data(), wlen);
    std::wstring wpath(wbuf.data());

    // Attach DXVA resources up front; tryOpen decides whether to use them.
    if (sharedDevice && sharedManager) {
        m_d3d11Device = sharedDevice;
        sharedDevice->GetImmediateContext(&m_d3d11Ctx);
        m_dxgiManager = sharedManager;
        m_ownsD3D11 = false;
        m_dxvaAvailable = true;
    } else {
        m_dxvaAvailable = initDXVA(nullptr);
        m_ownsD3D11 = m_dxvaAvailable;
    }

    // Decide the decode path once, here. Each attempt fully configures the
    // reader and validates it; on failure the reader is torn down and the next
    // mode is tried from scratch. The decode thread never changes mode.
    bool opened = false;

    // HAP is not another way of decoding the same stream but a different codec
    // altogether -- one Media Foundation has no decoder for, so every path
    // below would fail on it. Its frames are GPU texture blocks under Snappy;
    // the only work is undoing the Snappy.
    opened = tryOpen(wpath, Mode::Hap);

    // D3D12 video decode sits above the D3D11 paths: it is the only one that
    // never leaves the D3D12 device, so nothing has to be unwrapped, copied
    // or synchronised across APIs. It is also the narrowest -- H.264 frame
    // coding on tier 2 hardware -- so everything below it stays in place.
    // nv12Mode is App saying it can actually draw an NV12 texture -- it clears
    // the flag when the NV12 pipeline state failed to build. This path emits
    // nothing else, so without it the frames would be dropped at draw time and
    // the clip would render as nothing at all.
    if (!opened && d3d12Device && d3d12Queue && nv12Mode) {
        opened = tryOpen(wpath, Mode::D3D12);
        if (!opened) printf("[VideoDecoder] D3D12 video decode unavailable, trying NV12\n");
    }
    if (!opened && nv12Mode && d3d11On12Device && d3d12Queue && m_dxvaAvailable) {
        opened = tryOpen(wpath, Mode::NV12);
        if (!opened) printf("[VideoDecoder] NV12 path unavailable, trying BGRA\n");
    }
    if (!opened && m_dxvaAvailable) {
        opened = tryOpen(wpath, Mode::DxvaRgb32);
        if (!opened) printf("[VideoDecoder] DXVA path unavailable, trying software\n");
    }
    if (!opened) {
        opened = tryOpen(wpath, Mode::Software);
    }
    if (!opened) {
        fprintf(stderr, "[VideoDecoder] Failed to open %s in any mode\n", filePath.c_str());
        close();
        return false;
    }

    m_running = true;
    m_targetTime = 0.0;
    m_thread = std::thread(&VideoDecoder::decodeThread, this);

    const char* mode = m_mode == Mode::Hap ? "HAP_TEXTURE_BLOCKS" :
                       m_d3d12Decoder  ? "D3D12_VIDEO_DECODE" :
                       m_nv12Mode      ? "DXVA+NV12_ZEROCOPY" :
                       m_gpuSharing    ? "DXVA+GPU_SHARED" :
                       m_dxvaActive    ? "DXVA+CPU_READBACK" : "SOFTWARE";
    printf("[VideoDecoder] Opened %s (%ux%u, %.1f fps, %.1fs, %s %s)\n",
        filePath.c_str(), m_width, m_height, m_fps, m_duration, m_codecName, mode);
    return true;
}

bool VideoDecoder::open(const std::string& filePath, const DecoderParams& p) {
    return open(filePath, p.d3d12Device, p.d3d11Device, p.dxgiManager, p.d3d11On12,
                p.d3d12Queue, p.nv12Mode, p.sync);
}

// Configure the reader for one decode mode and validate it end to end.
// Returns false with the reader released so the caller can try the next mode.
bool VideoDecoder::tryOpen(const std::wstring& wpath, Mode mode) {
    m_reader.Reset();
    m_staging.Reset();
    m_writeable.clear();
    m_readable.clear();
    m_display = VideoFrame{};
    m_nv12Mode = false;
    m_gpuSharing = false;
    m_dxvaActive = false;
    m_d3d12Decoder.reset();
    m_seqHeader.clear();
    m_poolSize = POOL_SIZE;
    m_hapFormat = HapFormat::Unknown;

    if (mode == Mode::Hap) return tryOpenHap(wpath);
    if (mode == Mode::D3D12) return tryOpenD3D12(wpath);

    const bool wantDxva = (mode != Mode::Software) && m_dxvaAvailable;

    ComPtr<IMFAttributes> attrs;
    MFCreateAttributes(&attrs, 4);
    if (wantDxva) {
        attrs->SetUnknown(MF_SOURCE_READER_D3D_MANAGER, m_dxgiManager.Get());
        attrs->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, TRUE);
        attrs->SetUINT32(MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, TRUE);
    } else {
        attrs->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, TRUE);
    }

    HRESULT hr = MFCreateSourceReaderFromURL(wpath.c_str(), attrs.Get(), &m_reader);
    if (FAILED(hr)) {
        m_reader.Reset();
        return false;
    }

    m_dxvaActive = wantDxva;
    m_nv12Mode = (mode == Mode::NV12);

    if (!configureDecoder(mode)) {
        m_reader.Reset();
        m_nv12Mode = false;
        m_dxvaActive = false;
        return false;
    }

    m_frameDuration = (m_fps > 0) ? (1.0 / m_fps) : (1.0 / 30.0);

    // NV12 has to be proved, not assumed: the hardware may hand back P010
    // (VP9/AV1 10-bit), which our R8/R8G8 plane views cannot describe, and
    // UnwrapUnderlyingResource may fail outright.
    if (mode == Mode::NV12 && !probeNV12()) {
        m_reader.Reset();
        m_nv12Mode = false;
        m_dxvaActive = false;
        return false;
    }

    // Allocate the frame pool for the chosen mode.
    if (mode == Mode::NV12) {
        for (int i = 0; i < POOL_SIZE; i++) {
            VideoFrame f;
            f.width = m_width;
            f.height = m_height;
            m_writeable.push_back(std::move(f));
        }
        printf("[VideoDecoder] NV12 zero-copy frame pool created (%d pool)\n", POOL_SIZE);
    } else if (mode == Mode::DxvaRgb32 && m_d3d12Device &&
               (m_sharesRenderQueue || (m_sync.frameFence && m_sync.copyFence11 &&
                m_sync.copyFenceCounter && m_sync.copySignalMutex))) {
        bool allOk = true;
        for (int i = 0; i < POOL_SIZE; i++) {
            VideoFrame f;
            if (!createSharedTexture(f)) { allOk = false; break; }
            m_writeable.push_back(std::move(f));
        }
        if (allOk) {
            m_gpuSharing = true;
            printf("[VideoDecoder] GPU shared textures created (%d pool)\n", POOL_SIZE);
        } else {
            m_writeable.clear();   // ~VideoFrame closes the handles
            printf("[VideoDecoder] Shared texture creation failed, using CPU readback\n");
        }
    }

    if (!m_nv12Mode && !m_gpuSharing) {
        size_t sz = (size_t)m_width * m_height * 4;
        for (int i = 0; i < POOL_SIZE; i++) {
            VideoFrame f;
            f.pixels.resize(sz);
            m_writeable.push_back(std::move(f));
        }
    }

    m_mode = mode;
    return true;
}

// Open a HAP file: the source reader demultiplexes and the frames are the
// texture. Returns false quietly for anything that is not HAP so the ladder
// carries on; loudly for a HAP variant the renderer cannot show.
bool VideoDecoder::tryOpenHap(const std::wstring& wpath) {
    ComPtr<IMFAttributes> attrs;
    MFCreateAttributes(&attrs, 2);
    attrs->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, TRUE);

    HRESULT hr = MFCreateSourceReaderFromURL(wpath.c_str(), attrs.Get(), &m_reader);
    if (FAILED(hr)) { m_reader.Reset(); return false; }

    ComPtr<IMFMediaType> nativeType;
    if (FAILED(m_reader->GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &nativeType))) {
        m_reader.Reset();
        return false;
    }

    // The QuickTime sample description tag arrives as the first field of the
    // subtype GUID; hapFormatFromFourcc accepts either byte order.
    GUID subtype = {};
    HapFormat declared = HapFormat::Unknown;
    if (FAILED(nativeType->GetGUID(MF_MT_SUBTYPE, &subtype)) ||
        !hapFormatFromFourcc(subtype.Data1, declared)) {
        m_reader.Reset();
        return false;
    }
    if (declared == HapFormat::Unknown || declared == HapFormat::A_RGTC1) {
        printf("[VideoDecoder] %s is not supported: only Hap, Hap Alpha, Hap Q and Hap R\n",
            declared == HapFormat::A_RGTC1 ? "Hap Alpha-Only" : "Hap Q Alpha");
        m_reader.Reset();
        return false;
    }
    m_hapFormat = declared;
    m_codecName = hapFormatName(declared);

    UINT64 frameSize = 0;
    nativeType->GetUINT64(MF_MT_FRAME_SIZE, &frameSize);
    m_width = (UINT32)(frameSize >> 32);
    m_height = (UINT32)(frameSize & 0xFFFFFFFF);
    if (m_width == 0 || m_height == 0) { m_reader.Reset(); return false; }

    UINT64 frameRate = 0;
    if (SUCCEEDED(nativeType->GetUINT64(MF_MT_FRAME_RATE, &frameRate))) {
        UINT32 num = (UINT32)(frameRate >> 32);
        UINT32 den = (UINT32)(frameRate & 0xFFFFFFFF);
        if (den > 0) m_fps = (double)num / den;
    }
    m_frameDuration = (m_fps > 0) ? (1.0 / m_fps) : (1.0 / 30.0);

    PROPVARIANT var; PropVariantInit(&var);
    if (SUCCEEDED(m_reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE,
                                                     MF_PD_DURATION, &var))) {
        LONGLONG d = 0; PropVariantToInt64(var, &d);
        m_duration = (double)d / 10000000.0;
    }
    PropVariantClear(&var);

    m_reader->SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM, FALSE);
    m_reader->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);

    // Prove the first frame decodes before committing: a container can carry
    // the right tag over frames this parser cannot read.
    m_mode = Mode::Hap;
    VideoFrame probe;
    if (!readHapFrame(probe)) {
        printf("[VideoDecoder] %s: first frame did not decode\n", m_codecName);
        m_reader.Reset();
        m_mode = Mode::Software;
        return false;
    }
    {
        PROPVARIANT p; PropVariantInit(&p);
        p.vt = VT_I8; p.hVal.QuadPart = 0;
        m_reader->SetCurrentPosition(GUID_NULL, p);
        PropVariantClear(&p);
    }

    // Every frame is a keyframe and they arrive in order, so the default pool
    // is plenty; the block buffers are sized by the first decode into them.
    for (int i = 0; i < m_poolSize; i++) {
        VideoFrame f;
        f.width = m_width;
        f.height = m_height;
        m_writeable.push_back(std::move(f));
    }
    return true;
}

// One HAP frame: one sample, one Snappy pass, one texture.
bool VideoDecoder::readHapFrame(VideoFrame& dest) {
    if (!m_reader) return false;

    int failures = 0;
    for (int attempt = 0; attempt < 64; attempt++) {
        DWORD streamIndex = 0, flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        HRESULT hr = m_reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0,
                                          &streamIndex, &flags, &timestamp, &sample);
        if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) return false;
        if (!sample) continue;

        ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) return false;

        BYTE* data = nullptr;
        DWORD maxLen = 0, curLen = 0;
        if (FAILED(buffer->Lock(&data, &maxLen, &curLen)) || !data) return false;
        HapFormat format = HapFormat::Unknown;
        std::string error;
        const bool ok = hapDecodeFrame(data, curLen, m_width, m_height,
                                       dest.pixels, format, error);
        buffer->Unlock();

        if (!ok) {
            // A damaged frame is skipped, not treated as the end of the file;
            // only a run of them means the stream is unreadable.
            if (failures++ == 0) printf("[VideoDecoder] HAP frame rejected: %s\n", error.c_str());
            if (failures >= 16) return false;
            continue;
        }

        dest.width = m_width;
        dest.height = m_height;
        dest.codedWidth = dest.codedHeight = 0;
        dest.timestamp = (double)timestamp / 10000000.0;
        dest.nv12 = false;
        dest.pixelFormat = hapPixelFormat(format);
        dest.ycocg = (format == HapFormat::YCoCg_DXT5);
        m_decodedFrames.fetch_add(1);
        return true;
    }
    return false;
}

// Open for D3D12 video decode: the source reader demultiplexes and nothing
// more, and every picture is produced by the D3D12 video engine.
//
// Returns false with the reader released so open() can try the next mode.
// Every reason to refuse here is a reason to prefer D3D11On12, never to fail
// the file: the stream may not be H.264, it may be interlaced, the hardware
// may be tier 1.
bool VideoDecoder::tryOpenD3D12(const std::wstring& wpath) {
    if (!m_d3d12Device) return false;

    ComPtr<IMFAttributes> attrs;
    MFCreateAttributes(&attrs, 2);
    // Without this the reader inserts a decoder and hands back pixels.
    attrs->SetUINT32(MF_READWRITE_DISABLE_CONVERTERS, TRUE);

    HRESULT hr = MFCreateSourceReaderFromURL(wpath.c_str(), attrs.Get(), &m_reader);
    if (FAILED(hr)) { m_reader.Reset(); return false; }

    if (!configureCompressed()) { m_reader.Reset(); return false; }

    // The decoder allocates macroblock-aligned surfaces, so ask about the
    // aligned size rather than the cropped one the container advertises.
    const uint32_t probeW = (m_width + 15) & ~15u;
    const uint32_t probeH = (m_height + 15) & ~15u;
    if (!D3D12VideoDecoder::isSupported(m_d3d12Device, probeW, probeH)) {
        m_reader.Reset();
        return false;
    }

    auto decoder = std::make_unique<D3D12VideoDecoder>();
    decoder->setVerbose(m_verbose);
    if (!decoder->init(m_d3d12Device, probeW, probeH,
                       m_seqHeader.empty() ? nullptr : m_seqHeader.data(),
                       m_seqHeader.size())) {
        m_reader.Reset();
        return false;
    }
    m_d3d12Decoder = std::move(decoder);

    m_frameDuration = (m_fps > 0) ? (1.0 / m_fps) : (1.0 / 30.0);
    m_dxvaActive = true;

    // Prove the whole chain on this stream before committing to it, the same
    // way the NV12 path does. A parser that cannot read these slice headers
    // must not be discovered one frame into playback.
    if (!probeD3D12()) {
        m_d3d12Decoder.reset();
        m_reader.Reset();
        m_dxvaActive = false;
        return false;
    }

    // Pictures arrive in decode order, so the pool has to hold a whole reorder
    // window at once. A pool of POOL_SIZE empties before the picture the
    // renderer is waiting for has been decoded, and the frames that did arrive
    // get recycled as too old -- which loses two frames per mini-GOP on any
    // stream with B-pyramids, quietly, because the gaps are too small for the
    // drop counter to notice.
    m_poolSize = m_d3d12Decoder->framePoolSize();
    for (int i = 0; i < m_poolSize; i++) {
        VideoFrame f;
        f.width = m_width;
        f.height = m_height;
        m_writeable.push_back(std::move(f));
    }
    printf("[VideoDecoder] D3D12 video decode frame pool created (%d pool)\n", m_poolSize);

    m_mode = Mode::D3D12;
    return true;
}

// Read the compressed stream properties without setting an output type, which
// is what keeps the reader from inserting a decoder transform.
bool VideoDecoder::configureCompressed() {
    ComPtr<IMFMediaType> nativeType;
    if (FAILED(m_reader->GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, &nativeType)))
        return false;

    GUID subtype = {};
    if (FAILED(nativeType->GetGUID(MF_MT_SUBTYPE, &subtype))) return false;
    if (subtype != MFVideoFormat_H264 && subtype != MFVideoFormat_H264_ES) return false;
    m_codecName = "H.264";

    UINT64 frameSize = 0;
    nativeType->GetUINT64(MF_MT_FRAME_SIZE, &frameSize);
    m_width = (UINT32)(frameSize >> 32);
    m_height = (UINT32)(frameSize & 0xFFFFFFFF);
    if (m_width == 0 || m_height == 0) return false;

    UINT64 frameRate = 0;
    if (SUCCEEDED(nativeType->GetUINT64(MF_MT_FRAME_RATE, &frameRate))) {
        UINT32 num = (UINT32)(frameRate >> 32);
        UINT32 den = (UINT32)(frameRate & 0xFFFFFFFF);
        if (den > 0) m_fps = (double)num / den;
    }

    PROPVARIANT var; PropVariantInit(&var);
    if (SUCCEEDED(m_reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE,
                                                     MF_PD_DURATION, &var))) {
        LONGLONG d = 0; PropVariantToInt64(var, &d);
        m_duration = (double)d / 10000000.0;
    }
    PropVariantClear(&var);

    // Compressed output has no output media type to refine the colour
    // metadata, so the native type is the only source for it.
    readColorSpace(nativeType.Get());

    // Parameter sets out of band. A stream that repeats SPS/PPS on every
    // keyframe does not need these, but one that carries them only in the
    // container would otherwise never decode its first picture.
    UINT32 blobLen = 0;
    if (SUCCEEDED(nativeType->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &blobLen)) && blobLen > 0) {
        m_seqHeader.resize(blobLen);
        if (FAILED(nativeType->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER,
                                       m_seqHeader.data(), blobLen, nullptr))) {
            m_seqHeader.clear();
        }
    }

    m_reader->SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM, FALSE);
    m_reader->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);
    return true;
}

// Decode real samples until one produces a picture, then rewind. Proves the
// parser, the picture parameters and the hardware all agree about this file.
bool VideoDecoder::probeD3D12() {
    VideoFrame probe;
    bool ok = false;
    for (int attempt = 0; attempt < 8 && !ok; attempt++) {
        if (!readD3D12Frame(probe)) break;
        ok = probe.d3d12Texture != nullptr;
    }
    releaseD3D12Picture(probe);

    if (!ok) {
        printf("[VideoDecoder] D3D12 probe produced no picture\n");
        return false;
    }

    // Adopt the sizes the SPS reports: the container frame size can disagree
    // with the coded size, and the shader needs the ratio between them.
    const uint32_t w = m_d3d12Decoder->width();
    const uint32_t h = m_d3d12Decoder->height();
    if (w > 0 && h > 0) { m_width = w; m_height = h; }

    // The other decode paths read range and matrix off the MF decoder's output
    // type, which derives them from the VUI. Compressed output has no such
    // type, and the container carries them only if it has a colour box -- so
    // take them from the VUI directly, which is where they came from anyway.
    applySpsColorSpace(m_d3d12Decoder->activeSPS());

    m_d3d12Decoder->flush();

    PROPVARIANT p; PropVariantInit(&p);
    p.vt = VT_I8; p.hVal.QuadPart = 0;
    m_reader->SetCurrentPosition(GUID_NULL, p);
    PropVariantClear(&p);
    return true;
}

// Hand a picture back to the decoder so its slot can be reused. borrowFrame
// has already waited for the render queue to retire every read of it.
void VideoDecoder::releaseD3D12Picture(VideoFrame& frame) {
    if (m_d3d12Decoder && frame.d3d12Texture)
        m_d3d12Decoder->releasePicture(frame.d3d12Texture.Get());
    frame.d3d12Texture.Reset();
    frame.decodeFence = nullptr;
    frame.decodeFenceValue = 0;
}

// One decoded picture from the compressed stream.
//
// Samples do not map one to one onto pictures: a sample may carry only
// parameter sets, and after a seek the samples before the next recovery point
// decode into nothing, so keep reading until a picture comes out.
bool VideoDecoder::readD3D12Frame(VideoFrame& dest) {
    if (!m_d3d12Decoder || !m_reader) return false;
    releaseD3D12Picture(dest);

    int failures = 0;

    for (int attempt = 0; attempt < 64; attempt++) {
        DWORD streamIndex = 0, flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        HRESULT hr = m_reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0,
                                          &streamIndex, &flags, &timestamp, &sample);
        if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) return false;
        if (!sample) continue;

        ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) return false;

        BYTE* data = nullptr;
        DWORD maxLen = 0, curLen = 0;
        if (FAILED(buffer->Lock(&data, &maxLen, &curLen)) || !data) return false;
        D3D12DecodedPicture pic =
            m_d3d12Decoder->decode(data, curLen, (double)timestamp / 10000000.0);
        buffer->Unlock();

        if (!pic.valid) {
            // A sample that decodes to nothing is ordinary: parameter sets on
            // their own, or the pictures before the first recovery point after
            // a seek. A sample that fails is a damaged or unsupported access
            // unit -- skip it and keep reading, because reporting it as the end
            // of the stream freezes the clip until the next seek. Only a run of
            // failures means the stream is not decodable at all.
            if (!m_d3d12Decoder->failed()) { failures = 0; continue; }
            if (++failures >= 16) {
                printf("[VideoDecoder] giving up after %d consecutive decode failures\n",
                    failures);
                return false;
            }
            continue;
        }
        failures = 0;

        dest.d3d12Texture = pic.texture;
        dest.width = pic.width;
        dest.height = pic.height;
        // Carried on the frame rather than on the decoder: the picture being
        // drawn is not always the one most recently decoded, and the render
        // thread would otherwise be reading a value the decode thread is
        // writing.
        dest.codedWidth = pic.codedWidth;
        dest.codedHeight = pic.codedHeight;
        dest.timestamp = pic.pts;
        dest.nv12 = true;
        dest.decodeFence = m_d3d12Decoder->fence();
        dest.decodeFenceValue = pic.fenceValue;

        m_decodedFrames.fetch_add(1);
        return true;
    }
    return false;
}

// Decode one sample synchronously and confirm the whole NV12 chain works:
// the hardware really produced NV12, a matching copy texture can be created,
// and D3D11On12 can unwrap it into a D3D12 resource.
bool VideoDecoder::probeNV12() {
    if (!m_d3d11On12 || !m_d3d12Queue) return false;

    for (int attempt = 0; attempt < 30; attempt++) {
        DWORD streamIndex = 0, flags = 0;
        LONGLONG timestamp = 0;
        ComPtr<IMFSample> sample;
        HRESULT hr = m_reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0,
                                          &streamIndex, &flags, &timestamp, &sample);
        if (FAILED(hr) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) return false;
        if (!sample) continue;

        ComPtr<IMFMediaBuffer> buffer;
        if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) return false;

        ComPtr<IMFDXGIBuffer> dxgiBuf;
        if (FAILED(buffer->QueryInterface(IID_PPV_ARGS(&dxgiBuf)))) {
            printf("[VideoDecoder] NV12 probe: decoder is not producing GPU buffers\n");
            return false;
        }

        ComPtr<ID3D11Texture2D> tex;
        if (FAILED(dxgiBuf->GetResource(IID_PPV_ARGS(&tex)))) return false;

        D3D11_TEXTURE2D_DESC desc = {};
        tex->GetDesc(&desc);
        if (desc.Format != DXGI_FORMAT_NV12) {
            // P010 and friends need 16-bit plane views and a 10-bit shader
            // variant; until those exist, reject rather than misread them.
            printf("[VideoDecoder] NV12 probe: source format %u is not NV12\n", desc.Format);
            return false;
        }

        // Prove the unwrap path before committing to it.
        D3D11_TEXTURE2D_DESC copyDesc = {};
        copyDesc.Width = m_width;
        copyDesc.Height = m_height;
        copyDesc.MipLevels = 1;
        copyDesc.ArraySize = 1;
        copyDesc.Format = DXGI_FORMAT_NV12;
        copyDesc.SampleDesc.Count = 1;
        copyDesc.Usage = D3D11_USAGE_DEFAULT;
        copyDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        ComPtr<ID3D11Texture2D> probeTex;
        if (FAILED(m_d3d11Device->CreateTexture2D(&copyDesc, nullptr, &probeTex))) {
            printf("[VideoDecoder] NV12 probe: copy texture creation failed\n");
            return false;
        }
        ComPtr<ID3D12Resource> probeRes;
        hr = m_d3d11On12->UnwrapUnderlyingResource(probeTex.Get(), m_d3d12Queue, IID_PPV_ARGS(&probeRes));
        if (FAILED(hr)) {
            printf("[VideoDecoder] NV12 probe: UnwrapUnderlyingResource failed: 0x%08x\n", hr);
            return false;
        }
        m_d3d11On12->ReturnUnderlyingResource(probeTex.Get(), 0, nullptr, nullptr);

        // Rewind; the decode thread starts from zero.
        PROPVARIANT p; PropVariantInit(&p);
        p.vt = VT_I8; p.hVal.QuadPart = 0;
        m_reader->SetCurrentPosition(GUID_NULL, p);
        PropVariantClear(&p);
        return true;
    }
    return false;
}

void VideoDecoder::close() {
    if (m_running) {
        m_running = false;
        m_seekCv.notify_all();
        m_writeableCv.notify_all();
        if (m_thread.joinable()) m_thread.join();
    }
    m_reader.Reset();
    m_staging.Reset();

    // Return unwrapped NV12 resources. The NT shared handle is closed by
    // ~VideoFrame, so it no longer leaks for frames dropped outside close().
    auto cleanupFrame = [this](VideoFrame& f) {
        if (f.d3d11Source && m_d3d11On12) {
            m_d3d11On12->ReturnUnderlyingResource(f.d3d11Source.Get(), 0, nullptr, nullptr);
            f.d3d11Source.Reset();
        }
        releaseD3D12Picture(f);
    };
    for (auto& f : m_writeable) cleanupFrame(f);
    for (auto& f : m_readable) cleanupFrame(f);
    cleanupFrame(m_display);

    if (m_ownsD3D11) {
        m_dxgiManager.Reset();
        m_d3d11Ctx.Reset();
        m_d3d11Device.Reset();
    } else {
        m_dxgiManager = nullptr;
        m_d3d11Ctx = nullptr;
        m_d3d11Device = nullptr;
    }
    // After every frame has given its picture back, so the decoder is never
    // destroying textures the pool still points at.
    m_d3d12Decoder.reset();
    m_seqHeader.clear();
    m_hapFormat = HapFormat::Unknown;

    m_ownsD3D11 = false;
    m_dxvaActive = false;
    m_gpuSharing = false;
    m_nv12Mode = false;
    m_sharesRenderQueue = false;
    m_d3d12Device = nullptr;
    m_d3d12Queue = nullptr;
    m_d3d11On12 = nullptr;
    m_writeable.clear();
    m_readable.clear();
    m_display = VideoFrame{};
    m_dxvaAvailable = false;
    m_mode = Mode::Software;
    m_sync = {};
    m_pendingCopyFence.store(0);
    m_width = m_height = 0;
    m_defaultStride = 0;
    m_duration = 0; m_fps = 30.0;
}

// --- Configure decoder ---

bool VideoDecoder::configureDecoder(Mode mode) {
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

    // Detect codec from native subtype
    GUID subtype = {};
    if (SUCCEEDED(nativeType->GetGUID(MF_MT_SUBTYPE, &subtype))) {
        if (subtype == MFVideoFormat_H264 || subtype == MFVideoFormat_H264_ES) {
            m_codecName = "H.264";
        } else if (subtype == MFVideoFormat_HEVC || subtype == MFVideoFormat_HEVC_ES) {
            m_codecName = "HEVC";
        } else if (subtype == MFVideoFormat_VP90) {
            m_codecName = "VP9";
        } else if (subtype == MFVideoFormat_AV1) {
            m_codecName = "AV1";
        } else {
            m_codecName = "other";
        }
    }

    PROPVARIANT var; PropVariantInit(&var);
    if (SUCCEEDED(m_reader->GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &var))) {
        LONGLONG d = 0; PropVariantToInt64(var, &d);
        m_duration = (double)d / 10000000.0;
    }
    PropVariantClear(&var);

    readColorSpace(nativeType.Get());

    // Set output format
    ComPtr<IMFMediaType> outputType;
    MFCreateMediaType(&outputType);
    outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    outputType->SetGUID(MF_MT_SUBTYPE,
        (mode == Mode::NV12) ? MFVideoFormat_NV12 : MFVideoFormat_RGB32);
    outputType->SetUINT64(MF_MT_FRAME_SIZE, ((UINT64)m_width << 32) | m_height);

    hr = m_reader->SetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, outputType.Get());
    if (FAILED(hr)) {
        fprintf(stderr, "[VideoDecoder] Failed to set %s output: 0x%08x\n",
            (mode == Mode::NV12) ? "NV12" : "RGB32", hr);
        return false;
    }

    // The output type may refine the colour metadata; prefer it when present.
    ComPtr<IMFMediaType> actualType;
    if (SUCCEEDED(m_reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM, &actualType)) && actualType) {
        readColorSpace(actualType.Get());
        UINT32 stride = 0;
        if (SUCCEEDED(actualType->GetUINT32(MF_MT_DEFAULT_STRIDE, &stride)))
            m_defaultStride = static_cast<LONG>(stride);
        else if (mode != Mode::NV12)
            MFGetStrideForBitmapInfoHeader(MFVideoFormat_RGB32.Data1, m_width, &m_defaultStride);
    }

    m_reader->SetStreamSelection(MF_SOURCE_READER_FIRST_AUDIO_STREAM, FALSE);
    return m_width > 0 && m_height > 0;
}

// Fill m_colorSpace from the stream's nominal range and YUV matrix. Without
// this the NV12 shader assumed BT.709 limited range for everything, so SD
// (BT.601) and full-range content came out with wrong colours.
void VideoDecoder::readColorSpace(IMFMediaType* type) {
    if (!type) return;

    UINT32 range = 0;
    if (SUCCEEDED(type->GetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, &range))
        && range == MFNominalRange_0_255) {
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

    UINT32 matrix = 0;
    if (FAILED(type->GetUINT32(MF_MT_YUV_MATRIX, &matrix))) {
        // No metadata: SD resolutions are BT.601, HD and up are BT.709.
        matrix = (m_height > 0 && m_height <= 576)
            ? MFVideoTransferMatrix_BT601 : MFVideoTransferMatrix_BT709;
    }
    switch (matrix) {
    case MFVideoTransferMatrix_BT601:
        m_colorSpace.kr = 0.299f;  m_colorSpace.kb = 0.114f;  break;
    case MFVideoTransferMatrix_BT2020_10:
    case MFVideoTransferMatrix_BT2020_12:
        m_colorSpace.kr = 0.2627f; m_colorSpace.kb = 0.0593f; break;
    case MFVideoTransferMatrix_BT709:
    default:
        m_colorSpace.kr = 0.2126f; m_colorSpace.kb = 0.0722f; break;
    }
}

// Colour signal from the SPS VUI.
//
// Every other path gets this from the Media Foundation decoder's output type,
// which MF fills in from this same VUI. The D3D12 path has no decoder in the
// pipeline and so no output type, and the container's own colour box is
// optional and usually absent, so the VUI is read directly. Anything the
// stream leaves unspecified keeps whatever readColorSpace already worked out.
void VideoDecoder::applySpsColorSpace(const H264SPS& sps) {
    if (!sps.valid || !sps.vui_present) return;

    if (sps.video_full_range) {
        m_colorSpace.yOffset = 0.0f;
        m_colorSpace.yScale = 1.0f;
        m_colorSpace.cOffset = 128.0f / 255.0f;
        m_colorSpace.cScale = 1.0f;
    } else {
        m_colorSpace.yOffset = 16.0f / 255.0f;
        m_colorSpace.yScale = 255.0f / 219.0f;
        m_colorSpace.cOffset = 128.0f / 255.0f;
        m_colorSpace.cScale = 255.0f / 224.0f;
    }

    if (!sps.colour_description_present) return;
    switch (sps.matrix_coefficients) {
    case 1:                                        // BT.709
        m_colorSpace.kr = 0.2126f; m_colorSpace.kb = 0.0722f; break;
    case 5:                                        // BT.470BG
    case 6:                                        // SMPTE 170M -- both BT.601
        m_colorSpace.kr = 0.299f;  m_colorSpace.kb = 0.114f;  break;
    case 7:                                        // SMPTE 240M
        m_colorSpace.kr = 0.212f;  m_colorSpace.kb = 0.087f;  break;
    case 9:                                        // BT.2020 non-constant
    case 10:                                       // BT.2020 constant
        m_colorSpace.kr = 0.2627f; m_colorSpace.kb = 0.0593f; break;
    default:
        // 0 and 2 mean "unspecified", and 8 (YCgCo) is not a Y'CbCr matrix at
        // all. Leave the resolution-based guess in place rather than picking
        // a wrong one.
        break;
    }
}

int VideoDecoder::readableCount() const {
    std::lock_guard<std::mutex> lk(m_dealerMu);
    return (int)m_readable.size();
}

// ---- Render thread ----

const VideoFrame* VideoDecoder::getFrameAtTime(double timeSeconds, UINT64 currentFrameFence) {
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
        // whose first PTS is not zero (OBS recordings among them) therefore
        // never produced a thumbnail at t=0 and played black until that PTS.
        // When the earliest frame we hold is the closest thing to what was
        // asked for, show it.
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
                // command list being built, so record the fence value that
                // will retire it. The decode thread waits on this before
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
    // condition variable instead of polling m_writeable every 2 ms.
    if (returned) m_writeableCv.notify_one();
    if (timeChanged) m_seekCv.notify_one();

    if (m_display.width > 0) {
        // Publish the copy-fence value so App can make the render queue wait
        // for the D3D11 copy that produced this frame.
        UINT64 want = m_display.copyFenceValue;
        UINT64 cur = m_pendingCopyFence.load();
        while (want > cur && !m_pendingCopyFence.compare_exchange_weak(cur, want)) {}
        return &m_display;
    }
    return nullptr;
}

// Take a frame out of the writeable pool, waiting until one is returned.
// The pool is bounded, so seeks must borrow instead of allocating: both seek
// paths used to build a fresh VideoFrame and push it into the readable deque,
// growing the pool by one full-resolution texture on every scrub.
bool VideoDecoder::borrowFrame(VideoFrame& out) {
    std::unique_lock<std::mutex> lk(m_dealerMu);
    auto available = [this] {
        const UINT64 completed = m_sync.frameFence ? m_sync.frameFence->GetCompletedValue() : 0;
        return std::find_if(m_writeable.begin(), m_writeable.end(), [completed](const VideoFrame& f) {
            return f.releaseFenceValue == 0 ||
                (completed != UINT64_MAX && completed >= f.releaseFenceValue);
        });
    };
    // Never enqueue a GPU wait for the frame App is still recording: that
    // would block copies from every decoder sharing the D3D11 context, and
    // App may need one of those copies before it can signal this frame.
    // Poll retirement on this worker, leaving both GPU queues free to run.
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

// ---- Background decode thread ----

void VideoDecoder::decodeThread() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    {
        PROPVARIANT p; PropVariantInit(&p);
        p.vt = VT_I8; p.hVal.QuadPart = 0;
        m_reader->SetCurrentPosition(GUID_NULL, p);
        PropVariantClear(&p);
        if (m_d3d12Decoder) m_d3d12Decoder->flush();
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
                if (m_d3d12Decoder) m_d3d12Decoder->flush();
                m_seekCount.fetch_add(1);
                eof = false;

                {
                    std::lock_guard<std::mutex> dlk(m_dealerMu);
                    while (!m_readable.empty()) {
                        m_writeable.push_back(std::move(m_readable.back()));
                        m_readable.pop_back();
                    }
                }

                // Borrow from the pool rather than allocating: an allocated
                // frame ends up circulating in the pool forever, so every
                // scrub leaked a full-resolution texture and an NT handle.
                VideoFrame temp;
                if (!borrowFrame(temp)) continue;
                bool placed = false;
                for (int i = 0; i < 300 && m_running; i++) {
                    if (!readOneFrame(temp)) { eof = true; break; }
                    if (temp.timestamp >= seekT - m_frameDuration * 0.5) {
                        std::lock_guard<std::mutex> dlk(m_dealerMu);
                        m_readable.push_back(std::move(temp));
                        placed = true;
                        break;
                    }
                }
                if (!placed) recycle(std::move(temp));
                continue;
            }
        }

        if (eof) {
            std::unique_lock<std::mutex> lk(m_seekMu);
            m_seekCv.wait_for(lk, std::chrono::milliseconds(50));
            continue;
        }

        // Borrow a writeable frame, blocking on the pool's condition variable
        // rather than spinning at 2 ms while it is full.
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
            if (m_d3d12Decoder) m_d3d12Decoder->flush();
            m_seekCount.fetch_add(1);

            VideoFrame temp;
            if (!borrowFrame(temp)) continue;
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
    if (m_mode == Mode::Hap) return readHapFrame(dest);
    if (m_mode == Mode::D3D12) return readD3D12Frame(dest);

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

        dest.width = m_width;
        dest.height = m_height;
        dest.timestamp = (double)timestamp / 10000000.0;
        m_decodedFrames.fetch_add(1);

        // The mode was settled in open(); no path here can change it, so the
        // reader's output format and the code consuming it can never disagree.
        if (m_mode == Mode::NV12) {
            return writeNV12Frame(dest, tex.Get(), subIdx);
        }

        if (m_gpuSharing && dest.d3d11Shared) {
            // borrowFrame has already retired any D3D12 reads of this texture.
            m_d3d11Ctx->CopySubresourceRegion(
                dest.d3d11Shared.Get(), 0, 0, 0, 0,  // dest: shared texture
                tex.Get(), subIdx, nullptr);           // src: MF's decoded texture
            signalCopyDone(dest);
            return true;
        }

        // CPU readback fallback (no D3D12 device available)
        D3D11_TEXTURE2D_DESC desc;
        tex->GetDesc(&desc);

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

        m_d3d11Ctx->CopySubresourceRegion(m_staging.Get(), 0, 0, 0, 0, tex.Get(), subIdx, nullptr);

        D3D11_MAPPED_SUBRESOURCE mapped;
        hr = m_d3d11Ctx->Map(m_staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
        if (FAILED(hr)) return false;

        uint32_t rowBytes = m_width * 4;
        if (dest.pixels.size() != (size_t)rowBytes * m_height)
            dest.pixels.resize((size_t)rowBytes * m_height);

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

    // Use the pointer and stride from the same lock, including negative pitch.
    if (!copyVideoBuffer(buffer.Get(), m_width, m_height, m_defaultStride, dest.pixels))
        return false;
    dest.width = m_width;
    dest.height = m_height;
    dest.timestamp = (double)timestamp / 10000000.0;
    m_decodedFrames.fetch_add(1);
    return true;
}


// --- Cross-API synchronisation helpers ---
//
// The decode thread writes into pooled textures that D3D12 may still be
// sampling, and D3D12 samples textures the D3D11 copy may not have finished.
// Flush() only submits work. Standalone D3D11 copies signal a shared fence;
// borrowFrame checks the render fence on the CPU before reusing a texture.

void VideoDecoder::signalCopyDone(VideoFrame& frame) {
    // Same-queue: the copy is already ordered before anything the render
    // queue submits afterwards, so there is nothing for D3D12 to wait on.
    if (m_sharesRenderQueue || !m_sync.copyFence11 || !m_sync.copyFenceCounter) {
        m_d3d11Ctx->Flush();
        return;
    }
    ComPtr<ID3D11DeviceContext4> ctx4;
    if (FAILED(m_d3d11Ctx.As(&ctx4))) {
        m_d3d11Ctx->Flush();
        return;
    }
    // All decoders share this fence. Keep reservation and submission ordered
    // so concurrent workers cannot signal a smaller value after a larger one.
    std::lock_guard<std::mutex> lk(*m_sync.copySignalMutex);
    UINT64 v = m_sync.copyFenceCounter->fetch_add(1) + 1;
    ctx4->Signal(m_sync.copyFence11.Get(), v);
    m_d3d11Ctx->Flush();
    frame.copyFenceValue = v;
}

// NV12 zero-copy: copy the decoder's array slice into a standalone NV12
// texture and unwrap it as a D3D12 resource. open() already proved every step
// of this works for this stream, so a failure here is a hard error for the
// frame rather than a mid-stream format change.
bool VideoDecoder::writeNV12Frame(VideoFrame& dest, ID3D11Texture2D* src, UINT subIdx) {
    HRESULT hr = S_OK;

    // Hand the previous unwrap back.
    //
    // borrowFrame has already observed completion of every render using this
    // texture. No deferred GPU waits are needed to return it to D3D11On12.
    if (dest.d3d11Source) {
        m_d3d11On12->ReturnUnderlyingResource(dest.d3d11Source.Get(), 0, nullptr, nullptr);
        dest.d3d11Source.Reset();
        dest.d3d12Texture.Reset();
    }

    if (!dest.d3d11Shared) {
        D3D11_TEXTURE2D_DESC copyDesc = {};
        copyDesc.Width = m_width;
        copyDesc.Height = m_height;
        copyDesc.MipLevels = 1;
        copyDesc.ArraySize = 1;
        copyDesc.Format = DXGI_FORMAT_NV12;
        copyDesc.SampleDesc.Count = 1;
        copyDesc.Usage = D3D11_USAGE_DEFAULT;
        copyDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        hr = m_d3d11Device->CreateTexture2D(&copyDesc, nullptr, &dest.d3d11Shared);
        if (FAILED(hr)) {
            printf("[VideoDecoder] NV12 copy texture creation failed: 0x%08x\n", hr);
            return false;
        }
    }

    m_d3d11Ctx->CopySubresourceRegion(dest.d3d11Shared.Get(), 0, 0, 0, 0, src, subIdx, nullptr);
    m_d3d11Ctx->Flush();

    ComPtr<ID3D12Resource> d3d12Res;
    hr = m_d3d11On12->UnwrapUnderlyingResource(
        dest.d3d11Shared.Get(), m_d3d12Queue, IID_PPV_ARGS(&d3d12Res));
    if (FAILED(hr)) {
        printf("[VideoDecoder] UnwrapUnderlyingResource failed: 0x%08x\n", hr);
        dest.d3d11Shared.Reset();
        return false;
    }

    dest.d3d12Texture = d3d12Res;
    dest.d3d11Source = dest.d3d11Shared;
    dest.nv12 = true;
    // D3D11On12 submits the copy to the same DIRECT queue the renderer uses,
    // so in-order execution already orders it before the sampling draw.
    dest.copyFenceValue = 0;
    return true;
}
