#define NOMINMAX
#include "thumbnail.h"
#include "video_decoder.h"

#include <mfapi.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

// --- Block decompression ------------------------------------------------
//
// The GPU does this for playback; for a thumbnail it is a few hundred
// thousand texels once, and a CPU loop is simpler than spinning up a device.

void rgb565(uint16_t c, uint8_t& r, uint8_t& g, uint8_t& b) {
    r = (uint8_t)((((c >> 11) & 31) * 255 + 15) / 31);
    g = (uint8_t)((((c >> 5) & 63) * 255 + 31) / 63);
    b = (uint8_t)(((c & 31) * 255 + 15) / 31);
}

// One BC1 colour block into sixteen BGRA texels. `fourColour` forces the
// opaque palette regardless of endpoint order, which is how BC3 uses it.
void decodeBC1Block(const uint8_t* blk, uint8_t out[16][4], bool fourColour) {
    const uint16_t c0 = (uint16_t)(blk[0] | (blk[1] << 8));
    const uint16_t c1 = (uint16_t)(blk[2] | (blk[3] << 8));
    uint8_t pal[4][4];
    rgb565(c0, pal[0][2], pal[0][1], pal[0][0]); pal[0][3] = 255;
    rgb565(c1, pal[1][2], pal[1][1], pal[1][0]); pal[1][3] = 255;
    if (fourColour || c0 > c1) {
        for (int k = 0; k < 3; k++) {
            pal[2][k] = (uint8_t)((2 * pal[0][k] + pal[1][k]) / 3);
            pal[3][k] = (uint8_t)((pal[0][k] + 2 * pal[1][k]) / 3);
        }
        pal[2][3] = pal[3][3] = 255;
    } else {
        for (int k = 0; k < 3; k++) pal[2][k] = (uint8_t)((pal[0][k] + pal[1][k]) / 2);
        pal[2][3] = 255;
        pal[3][0] = pal[3][1] = pal[3][2] = pal[3][3] = 0;   // punch-through
    }
    const uint32_t idx = (uint32_t)blk[4] | ((uint32_t)blk[5] << 8) |
                         ((uint32_t)blk[6] << 16) | ((uint32_t)blk[7] << 24);
    for (int i = 0; i < 16; i++) {
        const uint8_t* p = pal[(idx >> (2 * i)) & 3];
        out[i][0] = p[0]; out[i][1] = p[1]; out[i][2] = p[2]; out[i][3] = p[3];
    }
}

// The BC3 alpha block: two endpoints and sixteen 3-bit indices.
void decodeBC3Alpha(const uint8_t* blk, uint8_t alpha[16]) {
    const uint8_t a0 = blk[0], a1 = blk[1];
    uint8_t pal[8] = { a0, a1 };
    if (a0 > a1) {
        for (int i = 1; i <= 6; i++) pal[i + 1] = (uint8_t)(((7 - i) * a0 + i * a1) / 7);
    } else {
        for (int i = 1; i <= 4; i++) pal[i + 1] = (uint8_t)(((5 - i) * a0 + i * a1) / 5);
        pal[6] = 0;
        pal[7] = 255;
    }
    uint64_t bits = 0;
    for (int i = 0; i < 6; i++) bits |= (uint64_t)blk[2 + i] << (8 * i);
    for (int i = 0; i < 16; i++) alpha[i] = pal[(bits >> (3 * i)) & 7];
}

// Hap Q: the DXT5 channels hold Co, Cg, a per-block scale and Y. Same
// arithmetic as effects_ps.hlsl, so the thumbnail matches the stage.
void ycocgToBgra(uint8_t* px) {
    // Memory order is B,G,R,A; the shader's .r/.g/.b/.a are Co, Cg, scale, Y.
    const float scale = (px[0] / 255.0f) * (255.0f / 8.0f) + 1.0f;
    const float Co = (px[2] / 255.0f - 128.0f / 255.0f) / scale;
    const float Cg = (px[1] / 255.0f - 128.0f / 255.0f) / scale;
    const float Y = px[3] / 255.0f;
    auto to8 = [](float v) { return (uint8_t)std::clamp(v * 255.0f + 0.5f, 0.0f, 255.0f); };
    px[2] = to8(Y + Co - Cg);   // R
    px[1] = to8(Y + Cg);        // G
    px[0] = to8(Y - Co - Cg);   // B
    px[3] = 255;
}

// Expand a block-compressed frame to BGRA. Returns false for formats that
// have no CPU path here.
bool blocksToBgra(const VideoFrame& f, std::vector<uint8_t>& bgra) {
    const uint32_t w = f.width, h = f.height;
    const uint32_t bw = (w + 3) / 4, bh = (h + 3) / 4;
    const bool bc1 = (f.pixelFormat == DXGI_FORMAT_BC1_UNORM);
    const bool bc3 = (f.pixelFormat == DXGI_FORMAT_BC3_UNORM);
    if (!bc1 && !bc3) return false;
    const size_t blockBytes = bc1 ? 8 : 16;
    if (f.pixels.size() < (size_t)bw * bh * blockBytes) return false;

    bgra.assign((size_t)w * h * 4, 0);
    for (uint32_t by = 0; by < bh; by++) {
        for (uint32_t bx = 0; bx < bw; bx++) {
            const uint8_t* blk = f.pixels.data() + ((size_t)by * bw + bx) * blockBytes;
            uint8_t texel[16][4];
            uint8_t alpha[16];
            if (bc3) {
                decodeBC3Alpha(blk, alpha);
                decodeBC1Block(blk + 8, texel, true);
                for (int i = 0; i < 16; i++) texel[i][3] = alpha[i];
            } else {
                decodeBC1Block(blk, texel, false);
            }
            for (int i = 0; i < 16; i++) {
                const uint32_t x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
                if (x >= w || y >= h) continue;
                uint8_t* dst = bgra.data() + ((size_t)y * w + x) * 4;
                dst[0] = texel[i][0]; dst[1] = texel[i][1];
                dst[2] = texel[i][2]; dst[3] = texel[i][3];
                if (f.ycocg) ycocgToBgra(dst);
            }
        }
    }
    return true;
}

// Area-average down to fit maxDim; a thumbnail wants no aliasing.
void downscale(const std::vector<uint8_t>& src, uint32_t sw, uint32_t sh, uint32_t maxDim,
               std::vector<uint8_t>& dst, uint32_t& dw, uint32_t& dh) {
    const uint32_t longest = std::max(sw, sh);
    if (longest <= maxDim) { dst = src; dw = sw; dh = sh; return; }
    const double k = (double)maxDim / longest;
    dw = std::max<uint32_t>(1, (uint32_t)(sw * k + 0.5));
    dh = std::max<uint32_t>(1, (uint32_t)(sh * k + 0.5));
    dst.assign((size_t)dw * dh * 4, 0);
    for (uint32_t y = 0; y < dh; y++) {
        const uint32_t y0 = (uint32_t)((uint64_t)y * sh / dh);
        const uint32_t y1 = std::max(y0 + 1, (uint32_t)((uint64_t)(y + 1) * sh / dh));
        for (uint32_t x = 0; x < dw; x++) {
            const uint32_t x0 = (uint32_t)((uint64_t)x * sw / dw);
            const uint32_t x1 = std::max(x0 + 1, (uint32_t)((uint64_t)(x + 1) * sw / dw));
            uint64_t acc[4] = {};
            uint64_t n = 0;
            for (uint32_t yy = y0; yy < y1; yy++)
                for (uint32_t xx = x0; xx < x1; xx++, n++) {
                    const uint8_t* p = src.data() + ((size_t)yy * sw + xx) * 4;
                    for (int c = 0; c < 4; c++) acc[c] += p[c];
                }
            uint8_t* d = dst.data() + ((size_t)y * dw + x) * 4;
            for (int c = 0; c < 4; c++) d[c] = (uint8_t)(acc[c] / n);
        }
    }
}

bool writePng(const std::string& path, const std::vector<uint8_t>& bgra, uint32_t w, uint32_t h) {
    ComPtr<IWICImagingFactory> factory;
    if (FAILED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&factory)))) return false;

    const int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    std::wstring wpath((size_t)wlen, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);

    ComPtr<IWICStream> stream;
    if (FAILED(factory->CreateStream(&stream))) return false;
    if (FAILED(stream->InitializeFromFilename(wpath.c_str(), GENERIC_WRITE))) return false;

    ComPtr<IWICBitmapEncoder> encoder;
    if (FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder))) return false;
    if (FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache))) return false;

    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> props;
    if (FAILED(encoder->CreateNewFrame(&frame, &props))) return false;
    if (FAILED(frame->Initialize(props.Get()))) return false;
    if (FAILED(frame->SetSize(w, h))) return false;
    WICPixelFormatGUID fmt = GUID_WICPixelFormat32bppBGRA;
    if (FAILED(frame->SetPixelFormat(&fmt))) return false;
    if (FAILED(frame->WritePixels(h, w * 4, (UINT)bgra.size(),
                                  const_cast<BYTE*>(bgra.data())))) return false;
    if (FAILED(frame->Commit())) return false;
    return SUCCEEDED(encoder->Commit());
}

}  // namespace

int runProbe(const std::string& inPath) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);

    int rc = 1;
    {
        VideoDecoder dec;
        if (!dec.open(inPath)) {
            fprintf(stderr, "probe: cannot open %s\n", inPath.c_str());
        } else {
            // open() has already read everything asked for here; the decode
            // thread it started is simply joined again by close().
            printf("{\"duration\":%.3f,\"width\":%u,\"height\":%u,\"fps\":%.3f,\"codec\":\"%s\"}\n",
                dec.duration(), dec.width(), dec.height(), dec.fps(), dec.codecName());
            fflush(stdout);
            dec.close();
            rc = 0;
        }
    }

    MFShutdown();
    CoUninitialize();
    return rc;
}

int runThumbnail(const std::string& inPath, const std::string& outPng,
                 double timeSeconds, uint32_t maxDim) {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);

    int rc = 1;
    {
        VideoDecoder dec;
        if (!dec.open(inPath)) {
            fprintf(stderr, "thumbnail: cannot open %s\n", inPath.c_str());
        } else {
            // The decode thread fills the pool; wait for the frame to arrive.
            const VideoFrame* f = nullptr;
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
            while (std::chrono::steady_clock::now() < deadline) {
                f = dec.getFrameAtTime(timeSeconds, 0);
                if (f && !f->pixels.empty()) break;
                f = nullptr;
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }

            if (!f) {
                fprintf(stderr, "thumbnail: no frame at %.3fs in %s\n", timeSeconds, inPath.c_str());
            } else {
                std::vector<uint8_t> bgra;
                bool ok = true;
                if (f->pixelFormat == DXGI_FORMAT_B8G8R8A8_UNORM) {
                    bgra = f->pixels;
                } else if (!blocksToBgra(*f, bgra)) {
                    fprintf(stderr, "thumbnail: no CPU decoder for pixel format %d\n", (int)f->pixelFormat);
                    ok = false;
                }
                if (ok) {
                    // Not `small`: rpcndr.h defines that as a macro.
                    std::vector<uint8_t> scaled;
                    uint32_t sw = 0, sh = 0;
                    downscale(bgra, f->width, f->height, maxDim, scaled, sw, sh);
                    if (writePng(outPng, scaled, sw, sh)) {
                        printf("thumbnail: %s (%ux%u, %s) -> %s (%ux%u)\n", inPath.c_str(),
                            f->width, f->height, dec.codecName(), outPng.c_str(), sw, sh);
                        rc = 0;
                    } else {
                        fprintf(stderr, "thumbnail: could not write %s\n", outPng.c_str());
                    }
                }
            }
            dec.close();
        }
    }

    MFShutdown();
    CoUninitialize();
    return rc;
}
