#define NOMINMAX
#include "video_buffer.h"
#include "video_decoder.h"
#include "media_loader.h"
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>

static void check(bool ok, const char* message) {
    if (!ok) throw std::runtime_error(message);
}

static void checkRows(const std::vector<uint8_t>& pixels, uint32_t width, uint32_t height) {
    check(pixels.size() == size_t(width) * height * 4, "incorrect output size");
    for (uint32_t y = 0; y < height; ++y) {
        for (uint32_t x = 0; x < width; ++x) {
            const size_t i = (size_t(y) * width + x) * 4;
            check(pixels[i] == y + 1 && pixels[i + 1] == y + 1 &&
                  pixels[i + 2] == y + 1 && pixels[i + 3] == 255,
                  "rows are flipped, misaligned or have incorrect alpha");
        }
    }
}

static void testBuffers() {
    constexpr uint32_t width = 3, height = 4;
    for (BOOL bottomUp : {FALSE, TRUE}) {
        ComPtr<IMFMediaBuffer> buffer;
        check(SUCCEEDED(MFCreate2DMediaBuffer(width, height, MFVideoFormat_RGB32.Data1,
                                            bottomUp, &buffer)), "create 2D buffer");
        ComPtr<IMF2DBuffer> twoD;
        check(SUCCEEDED(buffer.As(&twoD)), "get 2D buffer");
        BYTE* top = nullptr;
        LONG stride = 0;
        check(SUCCEEDED(twoD->Lock2D(&top, &stride)), "lock 2D buffer");
        check(bottomUp ? stride < 0 : stride > 0, "expected stride sign");
        check(std::abs(stride) > LONG(width * 4), "fixture must exercise padded rows");
        for (uint32_t y = 0; y < height; ++y)
            memset(top + ptrdiff_t(y) * stride, int(y + 1), width * 4);
        twoD->Unlock2D();
        std::vector<uint8_t> pixels;
        // Deliberately wrong fallback pitch: the 2D buffer's own pitch must win.
        check(copyVideoBuffer(buffer.Get(), width, height, 999, pixels), "copy 2D buffer");
        checkRows(pixels, width, height);
    }
    for (LONG stride : {LONG(width * 4), -LONG(width * 4)}) {
        ComPtr<IMFMediaBuffer> buffer;
        const DWORD size = width * height * 4;
        check(SUCCEEDED(MFCreateMemoryBuffer(size, &buffer)), "create flat buffer");
        BYTE* data = nullptr;
        buffer->Lock(&data, nullptr, nullptr);
        for (uint32_t y = 0; y < height; ++y) {
            uint32_t row = stride < 0 ? height - y - 1 : y;
            memset(data + row * width * 4, int(y + 1), width * 4);
        }
        buffer->Unlock();
        buffer->SetCurrentLength(size);
        std::vector<uint8_t> pixels;
        check(copyVideoBuffer(buffer.Get(), width, height, stride, pixels), "copy flat buffer");
        checkRows(pixels, width, height);
        buffer->SetCurrentLength(size - 1);
        check(!copyVideoBuffer(buffer.Get(), width, height, stride, pixels), "reject truncated buffer");
    }
}

struct RendererTestAccess {
    static void pool() {
        ComPtr<IDXGIFactory4> factory;
        ComPtr<IDXGIAdapter> warp;
        ComPtr<ID3D12Device> device;
        ComPtr<ID3D12Fence> fence;
        check(SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))), "create DXGI factory");
        check(SUCCEEDED(factory->EnumWarpAdapter(IID_PPV_ARGS(&warp))), "get WARP adapter");
        check(SUCCEEDED(D3D12CreateDevice(warp.Get(), D3D_FEATURE_LEVEL_11_0,
                                        IID_PPV_ARGS(&device))), "create WARP device");
        check(SUCCEEDED(device->CreateFence(0, D3D12_FENCE_FLAG_NONE,
                                           IID_PPV_ARGS(&fence))), "create retirement fence");
        VideoDecoder first, second;
        first.m_sync.frameFence = second.m_sync.frameFence = fence;
        first.m_running = second.m_running = true;
        VideoFrame pending, free;
        pending.releaseFenceValue = 7;
        pending.timestamp = 1;
        free.timestamp = 2;
        first.m_writeable.push_back(std::move(pending));
        second.m_writeable.push_back(std::move(free));
        VideoFrame out;
        check(!first.borrowFrame(out), "must not borrow a frame still sampled by the GPU");
        check(second.borrowFrame(out), "another decoder must still make progress");
        check(out.timestamp == 2, "borrowed wrong frame");
        check(SUCCEEDED(fence->Signal(7)), "complete the render frame");
        check(first.borrowFrame(out), "retired frame must become reusable");
        check(out.timestamp == 1 && out.releaseFenceValue == 0, "retirement was not cleared");
    }

    static void loader() {
        MediaLoader loader;
        DecoderParams params;
        loader.requestVideo("clip", "C:/first.mp4", params);
        const auto first = loader.m_queue.front();
        loader.requestVideo("clip", "C:/first.mp4", params);
        check(loader.m_queue.size() == 1, "identical requests must coalesce");
        loader.requestVideo("clip", "C:/second.mp4", params);
        check(loader.m_queue.size() == 1 && loader.m_queue.front().uri == "C:/second.mp4",
              "replacement must supersede queued media");
        const auto second = loader.m_queue.front();
        auto complete = [&](const auto& request) {
            MediaLoader::Ready ready;
            ready.key = request.key;
            ready.uri = request.uri;
            ready.generation = request.generation;
            loader.m_ready.push_back(std::move(ready));
        };
        complete(first); // Simulate an old load completing after replacement.
        complete(second);
        auto ready = loader.drainReady();
        check(ready.size() == 1 && ready[0].uri == "C:/second.mp4", "stale load was adopted");
        loader.forget("clip");
        loader.requestVideo("clip", "C:/first.mp4", params);
        complete(first); // A -> B -> A must not resurrect the first request.
        complete(loader.m_queue.front());
        ready = loader.drainReady();
        check(ready.size() == 1 && ready[0].generation != first.generation,
              "old generation survived invalidation");
        complete(loader.m_queue.front());
        loader.forget("clip");
        check(loader.m_queue.empty() && loader.drainReady().empty(), "removed clip survived invalidation");
    }
};

int main(int argc, char** argv) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);
    int result = 0;
    try {
        check(argc == 2, "expected test name");
        std::string name = argv[1];
        if (name == "buffers") testBuffers();
        else if (name == "pool") RendererTestAccess::pool();
        else if (name == "loader") RendererTestAccess::loader();
        else check(false, "unknown test");
        printf("PASS: %s\n", argv[1]);
    } catch (const std::exception& e) {
        fprintf(stderr, "FAIL: %s\n", e.what());
        result = 1;
    }
    MFShutdown();
    CoUninitialize();
    return result;
}
