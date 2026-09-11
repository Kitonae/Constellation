#pragma once
// Background media loader.
//
// WIC image decoding and MFCreateSourceReaderFromURL both take tens of
// milliseconds and used to run on the render thread the first frame a clip
// became active, producing a visible hitch at every clip start. The snapshot
// already lists every asset, so everything can be prepared ahead of time on
// this thread instead.

#include "video_decoder.h"

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

struct DecoderParams {
    ID3D12Device* d3d12Device = nullptr;
    ID3D11Device* d3d11Device = nullptr;
    IMFDXGIDeviceManager* dxgiManager = nullptr;
    ID3D11On12Device2* d3d11On12 = nullptr;
    ID3D12CommandQueue* d3d12Queue = nullptr;
    bool nv12Mode = false;
    bool verbose = false;
    DecoderSync sync;
};

class MediaLoader {
public:
    struct Ready {
        std::string key;                        // cache key / timeline item id
        std::string uri;
        std::vector<uint8_t> rgba;              // images: decoded pixels
        uint32_t width = 0;
        uint32_t height = 0;
        std::unique_ptr<VideoDecoder> decoder;  // videos: an opened decoder
        bool failed = false;
        uint64_t generation = 0;
    };

    ~MediaLoader();

    void start();
    void stop();

    // Both are idempotent: asking again for something already queued, already
    // in flight, or already delivered does nothing.
    void requestImage(const std::string& uri);
    void requestVideo(const std::string& key, const std::string& uri, const DecoderParams& params);

    // Called once per frame on the render thread.
    std::vector<Ready> drainReady();

    // Forget that `key` was handled, so it can be requested again after the
    // render thread evicted it.
    void forget(const std::string& key);

private:
    friend struct RendererTestAccess;
    struct Request {
        bool isVideo = false;
        std::string key;
        std::string uri;
        DecoderParams params;
        uint64_t generation = 0;
    };

    void request(Request req);
    bool isCurrent(const std::string& key, uint64_t generation) const;

    void threadMain();
    bool decodeImageFile(const std::string& uri, Ready& out);

    std::thread m_thread;
    std::atomic<bool> m_running{false};
    std::mutex m_mu;
    std::condition_variable m_cv;
    std::deque<Request> m_queue;
    std::vector<Ready> m_ready;
    struct Identity { std::string uri; uint64_t generation; };
    std::unordered_map<std::string, Identity> m_known;
    uint64_t m_nextGeneration = 0;
};
