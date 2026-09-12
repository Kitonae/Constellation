#define NOMINMAX
#include "video_buffer.h"
#include "video_decoder.h"
#include "media_loader.h"
#include "h264_parser.h"
#include "h264_bitstream.h"
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

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

// Writes the bitstream syntax the parser reads, so a parameter set can be
// built to order instead of being pasted in as opaque bytes.
class BitWriter {
public:
    void bit(uint32_t b) {
        if (m_count == 0) m_bytes.push_back(0);
        if (b) m_bytes.back() |= (uint8_t)(1 << (7 - m_count));
        m_count = (m_count + 1) % 8;
    }
    void bits(uint32_t value, int n) {
        for (int i = n - 1; i >= 0; i--) bit((value >> i) & 1);
    }
    /** ue(v): n leading zeroes, a one, then n bits of the remainder. */
    void ue(uint32_t value) {
        const uint32_t v = value + 1;
        int n = 0;
        while ((v >> (n + 1)) != 0) n++;
        for (int i = 0; i < n; i++) bit(0);
        bits(v, n + 1);
    }
    void se(int32_t value) {
        ue(value <= 0 ? (uint32_t)(-2 * value) : (uint32_t)(2 * value - 1));
    }
    /** rbsp_trailing_bits: a one, then zeroes to the byte boundary. */
    std::vector<uint8_t> finish() {
        bit(1);
        while (m_count != 0) bit(0);
        return m_bytes;
    }

private:
    std::vector<uint8_t> m_bytes;
    int m_count = 0;
};

static void testBitstream() {
    // Exp-Golomb, against the mapping in 9.1.
    {
        BitWriter w;
        const uint32_t values[] = { 0, 1, 2, 3, 8, 255, 65535 };
        for (uint32_t v : values) w.ue(v);
        for (int32_t v : { 0, 1, -1, 2, -2, 100, -100 }) w.se(v);
        auto data = w.finish();

        H264Bitstream bs(data.data(), data.size());
        for (uint32_t v : values) check(bs.readUE() == v, "ue(v) round trip");
        for (int32_t v : { 0, 1, -1, 2, -2, 100, -100 })
            check(bs.readSE() == v, "se(v) round trip");
        check(!bs.overrun(), "reader overran a well-formed bitstream");
    }

    // Emulation prevention: 0x000003 encodes 0x0000, and the 0x03 is not
    // payload. A reader that misses this shifts every field after it.
    {
        const uint8_t raw[] = { 0x00, 0x00, 0x03, 0x01, 0xFF };
        H264Bitstream bs(raw, sizeof(raw));
        check(bs.readBits(8) == 0x00, "first byte");
        check(bs.readBits(8) == 0x00, "second byte");
        check(bs.readBits(8) == 0x01, "prevention byte must be skipped");
        check(bs.readBits(8) == 0xFF, "byte after the prevention byte");
    }

    // Reading past the end latches, rather than returning plausible zeroes
    // that would reach the GPU as picture parameters.
    {
        const uint8_t raw[] = { 0xFF };
        H264Bitstream bs(raw, sizeof(raw));
        bs.readBits(8);
        check(!bs.overrun(), "exact reads must not report an overrun");
        bs.readBits(8);
        check(bs.overrun(), "reading past the end must be reported");
    }
}

static void testNalSplitting() {
    // Mixed three- and four-byte start codes, which is what Media Foundation
    // actually hands over: a four-byte code is a zero byte plus a three-byte
    // one, so the leading zero must not be left on the previous NAL.
    const uint8_t stream[] = {
        0x00, 0x00, 0x00, 0x01, 0x67, 0xAA, 0xBB,        // SPS, 4-byte
        0x00, 0x00, 0x01, 0x68, 0xCC,                    // PPS, 3-byte
        0x00, 0x00, 0x00, 0x01, 0x65, 0xDD, 0xEE, 0xFF,  // IDR, 4-byte
    };
    auto nals = H264Parser::findNalUnitsAnnexB(stream, sizeof(stream));
    check(nals.size() == 3, "expected three NAL units");

    check(nals[0].type == NAL_SPS && nals[0].nal_ref_idc == 3, "SPS header");
    check(nals[0].startCodeLen == 4 && nals[0].offset == 0, "SPS start code");
    check(nals[0].size == 2, "SPS payload excludes the next start code");

    check(nals[1].type == NAL_PPS, "PPS header");
    check(nals[1].startCodeLen == 3 && nals[1].offset == 7, "PPS start code");
    check(nals[1].size == 1, "PPS payload");

    check(nals[2].type == NAL_IDR_SLICE, "IDR header");
    check(nals[2].startCodeLen == 4 && nals[2].offset == 12, "IDR start code");
    check(nals[2].size == 3, "IDR payload runs to the end");

    // Length-prefixed framing, as an avcC box carries it.
    const uint8_t avcc[] = {
        0x00, 0x00, 0x00, 0x03, 0x67, 0xAA, 0xBB,
        0x00, 0x00, 0x00, 0x02, 0x68, 0xCC,
    };
    auto lp = H264Parser::findNalUnitsAVCC(avcc, sizeof(avcc), 4);
    check(lp.size() == 2, "expected two length-prefixed NAL units");
    check(lp[0].type == NAL_SPS && lp[0].size == 2, "length-prefixed SPS");
    check(lp[1].type == NAL_PPS && lp[1].size == 1, "length-prefixed PPS");
}

// A High-profile SPS that exercises, in one fixture, the branches the D3D12
// path depends on: the High-profile header, the scaling matrix fall-back, the
// cropping arithmetic, and the VUI fields the colour conversion and the frame
// pool are sized from.
static std::vector<uint8_t> buildHighProfileSps() {
    BitWriter w;
    w.bits(100, 8);          // profile_idc: High
    w.bits(0, 8);            // constraint flags + reserved
    w.bits(40, 8);           // level_idc: 4.0
    w.ue(0);                 // seq_parameter_set_id
    w.ue(1);                 // chroma_format_idc: 4:2:0
    w.ue(0);                 // bit_depth_luma_minus8
    w.ue(0);                 // bit_depth_chroma_minus8
    w.bit(0);                // qpprime_y_zero_transform_bypass_flag
    w.bit(1);                // seq_scaling_matrix_present_flag
    for (int i = 0; i < 8; i++) w.bit(0);   // every list absent -> fall back
    w.ue(0);                 // log2_max_frame_num_minus4
    w.ue(2);                 // pic_order_cnt_type
    w.ue(2);                 // max_num_ref_frames
    w.bit(0);                // gaps_in_frame_num_value_allowed_flag
    w.ue(119);               // pic_width_in_mbs_minus1   -> 1920
    w.ue(67);                // pic_height_in_map_units_minus1 -> 1088 coded
    w.bit(1);                // frame_mbs_only_flag
    w.bit(1);                // direct_8x8_inference_flag
    w.bit(1);                // frame_cropping_flag
    w.ue(0); w.ue(0); w.ue(0); w.ue(4);     // crop -> 1080 displayed
    w.bit(1);                // vui_parameters_present_flag
    w.bit(0);                //   aspect_ratio_info_present_flag
    w.bit(0);                //   overscan_info_present_flag
    w.bit(1);                //   video_signal_type_present_flag
    w.bits(5, 3);            //     video_format
    w.bit(1);                //     video_full_range_flag
    w.bit(1);                //     colour_description_present_flag
    w.bits(1, 8);            //       colour_primaries
    w.bits(1, 8);            //       transfer_characteristics
    w.bits(6, 8);            //       matrix_coefficients: BT.601
    w.bit(0);                //   chroma_loc_info_present_flag
    w.bit(0);                //   timing_info_present_flag
    w.bit(0);                //   nal_hrd_parameters_present_flag
    w.bit(0);                //   vcl_hrd_parameters_present_flag
    w.bit(0);                //   pic_struct_present_flag
    w.bit(1);                //   bitstream_restriction_flag
    w.bit(1);                //     motion_vectors_over_pic_boundaries_flag
    w.ue(0);                 //     max_bytes_per_pic_denom
    w.ue(0);                 //     max_bits_per_mb_denom
    w.ue(10);                //     log2_max_mv_length_horizontal
    w.ue(10);                //     log2_max_mv_length_vertical
    w.ue(3);                 //     max_num_reorder_frames
    w.ue(4);                 //     max_dec_frame_buffering
    return w.finish();
}

static void testSps() {
    const auto data = buildHighProfileSps();
    H264SPS sps;
    check(H264Parser::parseSPS(data.data(), data.size(), sps), "High-profile SPS must parse");

    check(sps.profile_idc == 100 && sps.level_idc == 40, "profile and level");
    check(sps.chroma_format_idc == 1, "chroma format");
    check(sps.max_num_ref_frames == 2, "reference count");
    check(sps.codedWidth() == 1920 && sps.codedHeight() == 1088, "coded size");
    check(sps.displayWidth() == 1920 && sps.displayHeight() == 1080, "cropped size");

    // The VUI is what the colour conversion and the frame pool are built from.
    check(sps.vui_present, "VUI present");
    check(sps.video_full_range, "full range flag");
    check(sps.colour_description_present && sps.matrix_coefficients == 6, "BT.601 matrix");
    check(sps.bitstream_restriction && sps.max_num_reorder_frames == 3, "reorder frames");
    check(sps.reorderDepth() == 3, "reorder depth comes from the VUI, not the ref count");

    // Every list is absent, so Table 7-2 falls list 0 and list 6 back to the
    // defaults. Those are held in scan order, the order the bitstream codes
    // them in and the order DXVA expects; the raster form the specification
    // prints them in would start 6,10,13,16 and dequantise High-profile
    // streams that select the default matrices with the wrong coefficients.
    const uint8_t expect8x8Intra[8] = { 6, 10, 10, 13, 11, 13, 16, 16 };
    for (int i = 0; i < 8; i++)
        check(sps.scaling_list_8x8[0][i] == expect8x8Intra[i],
              "default 8x8 intra list must be in scan order");
    const uint8_t expect8x8Inter[8] = { 9, 13, 13, 15, 13, 15, 17, 17 };
    for (int i = 0; i < 8; i++)
        check(sps.scaling_list_8x8[1][i] == expect8x8Inter[i],
              "default 8x8 inter list must be in scan order");
    const uint8_t expect4x4Intra[6] = { 6, 13, 13, 20, 20, 20 };
    for (int i = 0; i < 6; i++)
        check(sps.scaling_list_4x4[0][i] == expect4x4Intra[i],
              "default 4x4 intra list must be in scan order");

    // A PPS with no scaling matrix of its own inherits the SPS matrix rather
    // than falling back to flat.
    BitWriter pw;
    pw.ue(0);        // pic_parameter_set_id
    pw.ue(0);        // seq_parameter_set_id
    pw.bit(1);       // entropy_coding_mode_flag
    pw.bit(0);       // bottom_field_pic_order_in_frame_present_flag
    pw.ue(0);        // num_slice_groups_minus1
    pw.ue(1);        // num_ref_idx_l0_default_active_minus1
    pw.ue(0);        // num_ref_idx_l1_default_active_minus1
    pw.bit(0);       // weighted_pred_flag
    pw.bits(0, 2);   // weighted_bipred_idc
    pw.se(0);        // pic_init_qp_minus26
    pw.se(0);        // pic_init_qs_minus26
    pw.se(-2);       // chroma_qp_index_offset
    pw.bit(1);       // deblocking_filter_control_present_flag
    pw.bit(0);       // constrained_intra_pred_flag
    pw.bit(0);       // redundant_pic_cnt_present_flag
    const auto ppsData = pw.finish();

    H264PPS pps;
    check(H264Parser::parsePPS(ppsData.data(), ppsData.size(), sps, pps), "PPS must parse");
    check(pps.entropy_coding_mode, "CABAC flag");
    check(pps.num_ref_idx_l0_default == 2, "l0 default count");
    check(pps.chroma_qp_index_offset == -2, "chroma qp offset");
    check(pps.second_chroma_qp_index_offset == -2,
          "absent second offset mirrors the first");
    for (int i = 0; i < 8; i++)
        check(pps.scaling_list_8x8[0][i] == expect8x8Intra[i],
              "PPS matrix falls back to the SPS matrix, not to flat");
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
        else if (name == "bitstream") testBitstream();
        else if (name == "nal") testNalSplitting();
        else if (name == "sps") testSps();
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
