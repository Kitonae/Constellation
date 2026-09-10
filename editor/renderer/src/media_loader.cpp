#include "media_loader.h"
#include "uri_util.h"

#include <objbase.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <cstdio>

#pragma comment(lib, "windowscodecs.lib")

using Microsoft::WRL::ComPtr;

MediaLoader::~MediaLoader() { stop(); }

void MediaLoader::start() {
    if (m_running.exchange(true)) return;
    m_thread = std::thread(&MediaLoader::threadMain, this);
}

void MediaLoader::stop() {
    if (!m_running.exchange(false)) return;
    m_cv.notify_all();
    if (m_thread.joinable()) m_thread.join();
    std::lock_guard<std::mutex> lk(m_mu);
    m_queue.clear();
    m_ready.clear();
    m_known.clear();
}

void MediaLoader::requestImage(const std::string& uri) {
    if (uri.empty() || isRemoteUri(uri)) return;
    std::lock_guard<std::mutex> lk(m_mu);
    if (!m_known.insert(uri).second) return;
    m_queue.push_back(Request{false, uri, uri, {}});
    m_cv.notify_one();
}

void MediaLoader::requestVideo(const std::string& key, const std::string& uri,
                               const DecoderParams& params) {
    if (key.empty() || uri.empty() || isRemoteUri(uri)) return;
    std::lock_guard<std::mutex> lk(m_mu);
    if (!m_known.insert(key).second) return;
    m_queue.push_back(Request{true, key, uri, params});
    m_cv.notify_one();
}

void MediaLoader::forget(const std::string& key) {
    std::lock_guard<std::mutex> lk(m_mu);
    m_known.erase(key);
}

std::vector<MediaLoader::Ready> MediaLoader::drainReady() {
    std::vector<Ready> out;
    std::lock_guard<std::mutex> lk(m_mu);
    out.swap(m_ready);
    return out;
}

void MediaLoader::threadMain() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    while (m_running.load()) {
        Request req;
        {
            std::unique_lock<std::mutex> lk(m_mu);
            m_cv.wait(lk, [this] { return !m_queue.empty() || !m_running.load(); });
            if (!m_running.load()) break;
            req = std::move(m_queue.front());
            m_queue.pop_front();
        }

        Ready ready;
        ready.key = req.key;
        ready.uri = req.uri;

        if (req.isVideo) {
            std::string path = uriToPath(req.uri);
            if (path.empty()) {
                ready.failed = true;
            } else {
                auto dec = std::make_unique<VideoDecoder>();
                dec->setVerbose(req.params.verbose);
                if (dec->open(path, req.params.d3d12Device, req.params.d3d11Device,
                              req.params.dxgiManager, req.params.d3d11On12,
                              req.params.d3d12Queue, req.params.nv12Mode)) {
                    ready.decoder = std::move(dec);
                } else {
                    ready.failed = true;
                }
            }
        } else {
            if (!decodeImageFile(req.uri, ready)) ready.failed = true;
        }

        std::lock_guard<std::mutex> lk(m_mu);
        m_ready.push_back(std::move(ready));
    }

    CoUninitialize();
}

bool MediaLoader::decodeImageFile(const std::string& uri, Ready& out) {
    ComPtr<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&factory)))) return false;

    std::string path = uriToPath(uri);
    if (path.empty()) return false;

    int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    std::vector<wchar_t> wpath(wlen);
    MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);

    ComPtr<IWICBitmapDecoder> decoder;
    if (FAILED(factory->CreateDecoderFromFilename(wpath.data(), nullptr, GENERIC_READ,
        WICDecodeMetadataCacheOnDemand, &decoder))) return false;

    ComPtr<IWICBitmapFrameDecode> frame;
    if (FAILED(decoder->GetFrame(0, &frame))) return false;

    ComPtr<IWICFormatConverter> converter;
    if (FAILED(factory->CreateFormatConverter(&converter))) return false;
    if (FAILED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA,
        WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom))) return false;

    UINT w = 0, h = 0;
    converter->GetSize(&w, &h);
    if (w == 0 || h == 0) return false;

    UINT rowPitch = w * 4;
    out.rgba.resize((size_t)rowPitch * h);
    if (FAILED(converter->CopyPixels(nullptr, rowPitch, (UINT)out.rgba.size(), out.rgba.data())))
        return false;

    out.width = w;
    out.height = h;
    return true;
}
