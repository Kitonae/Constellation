#define NOMINMAX
#include "d3d12_video_decoder.h"
#include "h264_bitstream.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

#pragma comment(lib, "d3d12.lib")

namespace {

// DXVA wants the bitstream buffer padded out; drivers read in fixed-size
// chunks past the last slice byte.
constexpr size_t kBitstreamAlign = 128;

// Each ring region starts on a 64 KB boundary, which satisfies every offset
// alignment a driver asks of a compressed bitstream.
constexpr size_t kRegionAlign = 64 * 1024;

constexpr uint8_t kStartCode[3] = { 0x00, 0x00, 0x01 };

bool isSliceNal(H264NalType t) { return t == NAL_SLICE || t == NAL_IDR_SLICE; }

}  // namespace

D3D12VideoDecoder::~D3D12VideoDecoder() { shutdown(); }

// --- Capability ----------------------------------------------------------

bool D3D12VideoDecoder::isSupported(ID3D12Device* device, uint32_t width, uint32_t height) {
    if (!device || width == 0 || height == 0) return false;

    ComPtr<ID3D12VideoDevice> videoDevice;
    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&videoDevice)))) return false;

    D3D12_FEATURE_DATA_VIDEO_DECODE_SUPPORT s = {};
    s.NodeIndex = 0;
    s.Configuration.DecodeProfile = D3D12_VIDEO_DECODE_PROFILE_H264;
    s.Configuration.BitstreamEncryption = D3D12_BITSTREAM_ENCRYPTION_TYPE_NONE;
    s.Configuration.InterlaceType = D3D12_VIDEO_FRAME_CODED_INTERLACE_TYPE_NONE;
    s.Width = width;
    s.Height = height;
    s.DecodeFormat = DXGI_FORMAT_NV12;
    s.FrameRate = { 30, 1 };
    s.BitRate = 0;

    if (FAILED(videoDevice->CheckFeatureSupport(D3D12_FEATURE_VIDEO_DECODE_SUPPORT, &s, sizeof(s))))
        return false;
    if (!(s.SupportFlags & D3D12_VIDEO_DECODE_SUPPORT_FLAG_SUPPORTED)) return false;

    // Tier 1 requires every reference frame to live in one texture array, and
    // reference-only allocations cannot be bound as a shader resource. Both
    // rule out handing the decoded picture straight to the renderer, which is
    // the entire point of this path, so defer to D3D11On12 instead.
    if (s.DecodeTier < D3D12_VIDEO_DECODE_TIER_2) {
        printf("[D3D12VDec] decode tier %d is below tier 2; using the D3D11On12 path\n",
            (int)s.DecodeTier);
        return false;
    }
    if (s.ConfigurationFlags & D3D12_VIDEO_DECODE_CONFIGURATION_FLAG_REFERENCE_ONLY_ALLOCATIONS_REQUIRED) {
        printf("[D3D12VDec] hardware requires reference-only allocations; "
               "using the D3D11On12 path\n");
        return false;
    }
    return true;
}

// --- Initialisation ------------------------------------------------------

bool D3D12VideoDecoder::init(ID3D12Device* device, uint32_t width, uint32_t height,
                             const uint8_t* seqHeader, size_t seqHeaderSize) {
    if (!device) return false;
    m_device = device;

    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&m_videoDevice)))) {
        printf("[D3D12VDec] ID3D12VideoDevice is unavailable\n");
        return false;
    }

    D3D12_COMMAND_QUEUE_DESC qd = {};
    qd.Type = D3D12_COMMAND_LIST_TYPE_VIDEO_DECODE;
    qd.Priority = D3D12_COMMAND_QUEUE_PRIORITY_NORMAL;
    if (FAILED(device->CreateCommandQueue(&qd, IID_PPV_ARGS(&m_queue)))) {
        printf("[D3D12VDec] video decode queue creation failed\n");
        return false;
    }

    for (int i = 0; i < D3D12_DEC_RING; i++) {
        if (FAILED(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_VIDEO_DECODE,
                                                  IID_PPV_ARGS(&m_alloc[i])))) {
            printf("[D3D12VDec] command allocator %d creation failed\n", i);
            return false;
        }
        m_allocFence[i] = 0;
    }

    ComPtr<ID3D12CommandList> list;
    if (FAILED(device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_VIDEO_DECODE,
                                         m_alloc[0].Get(), nullptr, IID_PPV_ARGS(&list))) ||
        FAILED(list.As(&m_cmdList))) {
        printf("[D3D12VDec] video decode command list creation failed\n");
        return false;
    }
    m_cmdList->Close();

    if (FAILED(device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_fence)))) return false;
    m_fenceEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    if (!m_fenceEvent) return false;

    m_initialized = true;
    resetDpb();

    // Out-of-band parameter sets, when the container carries them. Without
    // this a stream that never repeats its SPS in band would decode nothing.
    if (seqHeader && seqHeaderSize > 0) {
        auto nals = H264Parser::findNalUnitsAnnexB(seqHeader, seqHeaderSize);
        ingestParameterSets(nals);
    }

    // A parameter set this decoder cannot honour is a hard failure, not
    // something to work around: building an 8-bit progressive decoder anyway
    // and feeding it a 10-bit or interlaced stream produces pictures the
    // caller cannot use and skips the fallback that would have played them.
    if (m_spsRefused) {
        shutdown();
        return false;
    }

    // Nothing allocated yet: everything waits for the first in-band parameter
    // set, which is the only thing that says how deep the pool has to be.
    if (!m_haveParameterSets) {
        printf("[D3D12VDec] initialised, waiting for in-band parameter sets\n");
        return true;
    }

    printf("[D3D12VDec] initialised (%ux%u coded, %d pictures)\n",
        m_codedWidth, m_codedHeight, m_picCount);
    return true;
}

bool D3D12VideoDecoder::createDecoder(uint32_t codedWidth, uint32_t codedHeight) {
    if (codedWidth == 0 || codedHeight == 0) return false;

    D3D12_VIDEO_DECODER_DESC dd = {};
    dd.NodeMask = 0;
    dd.Configuration.DecodeProfile = D3D12_VIDEO_DECODE_PROFILE_H264;
    dd.Configuration.BitstreamEncryption = D3D12_BITSTREAM_ENCRYPTION_TYPE_NONE;
    dd.Configuration.InterlaceType = D3D12_VIDEO_FRAME_CODED_INTERLACE_TYPE_NONE;

    m_decoder.Reset();
    HRESULT hr = m_videoDevice->CreateVideoDecoder(&dd, IID_PPV_ARGS(&m_decoder));
    if (FAILED(hr)) {
        printf("[D3D12VDec] CreateVideoDecoder failed: 0x%08x\n", hr);
        return false;
    }

    D3D12_VIDEO_DECODER_HEAP_DESC hd = {};
    hd.NodeMask = 0;
    hd.Configuration = dd.Configuration;
    hd.DecodeWidth = codedWidth;
    hd.DecodeHeight = codedHeight;
    hd.Format = DXGI_FORMAT_NV12;
    hd.FrameRate = { 30, 1 };
    hd.BitRate = 0;
    hd.MaxDecodePictureBufferCount = m_picCount;

    m_decoderHeap.Reset();
    hr = m_videoDevice->CreateVideoDecoderHeap(&hd, IID_PPV_ARGS(&m_decoderHeap));
    if (FAILED(hr)) {
        printf("[D3D12VDec] CreateVideoDecoderHeap failed: 0x%08x\n", hr);
        return false;
    }

    m_codedWidth = codedWidth;
    m_codedHeight = codedHeight;
    return true;
}

bool D3D12VideoDecoder::createPictures(uint32_t codedWidth, uint32_t codedHeight) {
    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = D3D12_HEAP_TYPE_DEFAULT;

    D3D12_RESOURCE_DESC td = {};
    td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    td.Width = codedWidth;
    td.Height = codedHeight;
    td.DepthOrArraySize = 1;
    td.MipLevels = 1;
    td.Format = DXGI_FORMAT_NV12;
    td.SampleDesc.Count = 1;
    td.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    // See the file header: simultaneous access is what lets the render queue
    // sample a picture the decode queue is still using as a reference.
    td.Flags = D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;

    m_picTextures.fill(nullptr);
    for (int i = 0; i < m_picCount; i++) {
        // Every slot is replaced, so all of its state goes with it -- including
        // heldByClient. Keeping that flag across a rebuild would strand the
        // slot forever, because releasePicture matches on the texture pointer
        // and the caller is holding the old texture, not this new one.
        m_pics[i] = Picture{};
        HRESULT hr = m_device->CreateCommittedResource(
            &hp, D3D12_HEAP_FLAG_NONE, &td, D3D12_RESOURCE_STATE_COMMON,
            nullptr, IID_PPV_ARGS(&m_pics[i].tex));
        if (FAILED(hr)) {
            printf("[D3D12VDec] picture %d (%ux%u NV12) creation failed: 0x%08x\n",
                i, codedWidth, codedHeight, hr);
            return false;
        }
        m_picTextures[i] = m_pics[i].tex.Get();
        m_picSubresources[i] = 0;
    }
    for (int i = m_picCount; i < D3D12_DEC_PIC_POOL_MAX; i++) m_pics[i] = Picture{};
    return true;
}

// What this decoder can actually handle. Kept separate from applySPS so that
// every picture can be checked against its own active SPS: a stream may carry
// several, and only the first one seen used to decide anything.
bool D3D12VideoDecoder::spsSupported(const H264SPS& sps, const char** why) {
    if (!sps.valid) { *why = "the parameter set did not parse"; return false; }
    if (!sps.frame_mbs_only) { *why = "the stream is interlaced (frame_mbs_only=0)"; return false; }
    if (sps.chroma_format_idc != 1) { *why = "only 4:2:0 chroma is supported"; return false; }
    if (sps.bit_depth_luma != 8 || sps.bit_depth_chroma != 8) {
        *why = "only 8-bit sample depth is supported";
        return false;
    }
    return true;
}

bool D3D12VideoDecoder::applySPS(const H264SPS& sps) {
    const char* why = nullptr;
    if (!spsSupported(sps, &why)) {
        printf("[D3D12VDec] %s; falling back to the D3D11On12 path\n", why);
        return false;
    }

    // Size the pool for this stream. Reference frames must all stay resident,
    // the caller holds a reorder window plus the picture on screen, and one
    // more is being decoded into.
    const int refs = (int)(sps.max_num_ref_frames < 16 ? sps.max_num_ref_frames : 16);
    m_reorderDepth = (int)(sps.reorderDepth() < 16 ? sps.reorderDepth() : 16);
    m_framePool = m_reorderDepth + 4;
    if (m_framePool < 4) m_framePool = 4;
    if (m_framePool > 12) m_framePool = 12;
    int wanted = refs + m_framePool + 2;
    if (wanted < 8) wanted = 8;
    if (wanted > D3D12_DEC_PIC_POOL_MAX) wanted = D3D12_DEC_PIC_POOL_MAX;

    const uint32_t cw = sps.codedWidth();
    const uint32_t ch = sps.codedHeight();
    m_dispWidth = sps.displayWidth();
    m_dispHeight = sps.displayHeight();
    m_activeSps = sps;

    if (m_decoder && m_decoderHeap && cw == m_codedWidth && ch == m_codedHeight &&
        m_pics[0].tex && wanted <= m_picCount) {
        return true;   // same geometry and a deep enough pool, nothing to rebuild
    }
    m_picCount = wanted;

    // Resolution change: everything in flight refers to the old pictures.
    if (m_fenceValue > 0 && m_fence->GetCompletedValue() < m_fenceValue) {
        m_fence->SetEventOnCompletion(m_fenceValue, m_fenceEvent);
        WaitForSingleObject(m_fenceEvent, 2000);
    }
    resetDpb();

    if (!createDecoder(cw, ch)) return false;
    if (!createPictures(cw, ch)) return false;

    printf("[D3D12VDec] stream is %ux%u (coded %ux%u), profile %u level %u, "
           "%d refs, reorder %d, %d pictures\n",
        m_dispWidth, m_dispHeight, cw, ch, sps.profile_idc, sps.level_idc,
        refs, m_reorderDepth, m_picCount);
    return true;
}

void D3D12VideoDecoder::ingestParameterSets(const std::vector<H264NalUnit>& nals) {
    for (const auto& nal : nals) {
        if (nal.type == NAL_SPS) {
            H264SPS sps;
            if (H264Parser::parseSPS(nal.data, nal.size, sps) && sps.sps_id < m_sps.size()) {
                m_sps[sps.sps_id] = sps;
                if (applySPS(sps)) m_haveParameterSets = true;
                else m_spsRefused = true;
            }
        } else if (nal.type == NAL_PPS) {
            // A PPS scaling matrix falls back to its SPS, so the SPS has to be
            // in hand before the PPS is parsed, not merely before it is used.
            H264Bitstream peek(nal.data, nal.size);
            peek.readUE();                       // pic_parameter_set_id
            uint32_t spsId = peek.readUE();
            if (spsId >= m_sps.size() || !m_sps[spsId].valid) continue;

            H264PPS pps;
            if (H264Parser::parsePPS(nal.data, nal.size, m_sps[spsId], pps) &&
                pps.pps_id < m_pps.size()) {
                m_pps[pps.pps_id] = pps;
            }
        }
    }
}

// --- Decoded picture buffer ---------------------------------------------

void D3D12VideoDecoder::resetDpb() {
    for (auto& p : m_pics) {
        p.inUse = false;
        p.shortTerm = false;
        p.longTerm = false;
        p.frameNum = 0;
        p.frameNumWrap = 0;
        p.longTermFrameIdx = 0;
        p.topPoc = 0;
        p.bottomPoc = 0;
        // heldByClient is deliberately untouched: the renderer may still be
        // sampling that texture, and only releasePicture may clear it.
    }
    m_prevPocMsb = 0;
    m_prevPocLsb = 0;
    m_prevFrameNumOffset = 0;
    m_prevFrameNum = 0;
    m_prevHadMMCO5 = false;
    m_maxLongTermFrameIdx = -1;
}

void D3D12VideoDecoder::flush() {
    if (!m_initialized) return;
    if (m_fenceValue > 0 && m_fence->GetCompletedValue() < m_fenceValue) {
        m_fence->SetEventOnCompletion(m_fenceValue, m_fenceEvent);
        WaitForSingleObject(m_fenceEvent, 2000);
    }
    resetDpb();
    m_awaitingRecovery = true;
}

int D3D12VideoDecoder::allocPicture() {
    // A picture is reusable once it is neither a reference nor on screen.
    for (int i = 0; i < m_picCount; i++) {
        const Picture& p = m_pics[i];
        if (!p.inUse && !p.heldByClient) return i;
    }
    for (int i = 0; i < m_picCount; i++) {
        Picture& p = m_pics[i];
        if (!p.isReference() && !p.heldByClient) { p.inUse = false; return i; }
    }
    return -1;
}

void D3D12VideoDecoder::releasePicture(ID3D12Resource* texture) {
    if (!texture) return;
    for (auto& p : m_pics) {
        if (p.tex.Get() == texture) { p.heldByClient = false; return; }
    }
}

// PicNum for frame coding (8.2.4.1): references numbered ahead of the current
// picture belong to the previous frame_num cycle.
void D3D12VideoDecoder::updateFrameNumWrap(int32_t currFrameNum, uint32_t maxFrameNum) {
    for (auto& p : m_pics) {
        if (!p.inUse || !p.shortTerm) continue;
        p.frameNumWrap = (p.frameNum > currFrameNum)
            ? p.frameNum - (int32_t)maxFrameNum
            : p.frameNum;
    }
}

// --- Picture order count (8.2.1) ----------------------------------------

void D3D12VideoDecoder::computePoc(const H264SPS& sps, const H264SliceHeader& slice,
                                   int32_t& topPoc, int32_t& bottomPoc) {
    const int32_t maxFrameNum = (int32_t)sps.maxFrameNum();

    if (sps.pic_order_cnt_type == 0) {
        const int32_t maxLsb = (int32_t)sps.maxPocLsb();
        int32_t prevMsb = 0, prevLsb = 0;
        if (!slice.idr) {
            if (m_prevHadMMCO5) {
                // MMCO 5 leaves the previous picture with a top POC of zero.
                prevMsb = 0;
                prevLsb = 0;
            } else {
                prevMsb = m_prevPocMsb;
                prevLsb = m_prevPocLsb;
            }
        }

        const int32_t lsb = (int32_t)slice.pic_order_cnt_lsb;
        int32_t msb;
        if (lsb < prevLsb && (prevLsb - lsb) >= maxLsb / 2)      msb = prevMsb + maxLsb;
        else if (lsb > prevLsb && (lsb - prevLsb) > maxLsb / 2)  msb = prevMsb - maxLsb;
        else                                                      msb = prevMsb;

        topPoc = msb + lsb;
        bottomPoc = topPoc + slice.delta_pic_order_cnt_bottom;

        // Only reference pictures carry the count forward.
        if (slice.nal_ref_idc != 0) {
            m_prevPocMsb = msb;
            m_prevPocLsb = lsb;
        }
        m_prevFrameNum = (int32_t)slice.frame_num;
        return;
    }

    // A picture carrying MMCO 5 is treated afterwards as though its frame_num
    // were zero and its offset reset, so the picture that follows must not
    // inherit the values from before the reset.
    const int32_t prevOffset = m_prevHadMMCO5 ? 0 : m_prevFrameNumOffset;
    const int32_t prevNum = m_prevHadMMCO5 ? 0 : m_prevFrameNum;

    int32_t frameNumOffset;
    if (slice.idr) frameNumOffset = 0;
    else if (prevNum > (int32_t)slice.frame_num) frameNumOffset = prevOffset + maxFrameNum;
    else frameNumOffset = prevOffset;

    if (sps.pic_order_cnt_type == 1) {
        const int cycle = sps.num_ref_frames_in_poc_cycle;
        int32_t absFrameNum = (cycle != 0) ? frameNumOffset + (int32_t)slice.frame_num : 0;
        if (slice.nal_ref_idc == 0 && absFrameNum > 0) absFrameNum--;

        int32_t expectedPoc = 0;
        if (absFrameNum > 0) {
            int32_t deltaPerCycle = 0;
            for (int i = 0; i < cycle; i++) deltaPerCycle += sps.offset_for_ref_frame[i];
            const int32_t cycleCnt = (absFrameNum - 1) / cycle;
            const int32_t inCycle = (absFrameNum - 1) % cycle;
            expectedPoc = cycleCnt * deltaPerCycle;
            for (int32_t i = 0; i <= inCycle; i++) expectedPoc += sps.offset_for_ref_frame[i];
        }
        if (slice.nal_ref_idc == 0) expectedPoc += sps.offset_for_non_ref_pic;

        topPoc = expectedPoc + slice.delta_pic_order_cnt[0];
        bottomPoc = topPoc + sps.offset_for_top_to_bottom_field + slice.delta_pic_order_cnt[1];
    } else {
        int32_t poc;
        if (slice.idr) poc = 0;
        else if (slice.nal_ref_idc == 0) poc = 2 * (frameNumOffset + (int32_t)slice.frame_num) - 1;
        else poc = 2 * (frameNumOffset + (int32_t)slice.frame_num);
        topPoc = bottomPoc = poc;
    }

    m_prevFrameNumOffset = frameNumOffset;
    m_prevFrameNum = (int32_t)slice.frame_num;
}

// --- Reference marking (8.2.5) ------------------------------------------

void D3D12VideoDecoder::slidingWindow(const H264SPS& sps) {
    int numRefs = 0;
    for (const auto& p : m_pics) if (p.inUse && p.isReference()) numRefs++;

    const int maxRefs = std::max<int>(sps.max_num_ref_frames, 1);
    while (numRefs >= maxRefs) {
        // Evict the short-term reference with the smallest FrameNumWrap.
        int victim = -1;
        for (int i = 0; i < m_picCount; i++) {
            const Picture& p = m_pics[i];
            if (!p.inUse || !p.shortTerm) continue;
            if (victim < 0 || p.frameNumWrap < m_pics[victim].frameNumWrap) victim = i;
        }
        if (victim < 0) break;   // only long-term references left
        m_pics[victim].shortTerm = false;
        numRefs--;
    }
}

void D3D12VideoDecoder::markReferences(const H264SPS& sps, const H264SliceHeader& slice,
                                       int slot) {
    Picture& curr = m_pics[slot];

    if (slice.idr) {
        for (int i = 0; i < m_picCount; i++) {
            if (i == slot) continue;
            m_pics[i].shortTerm = false;
            m_pics[i].longTerm = false;
        }
        if (slice.long_term_reference_flag) {
            curr.longTerm = true;
            curr.longTermFrameIdx = 0;
            m_maxLongTermFrameIdx = 0;
        } else {
            curr.shortTerm = true;
            m_maxLongTermFrameIdx = -1;
        }
        return;
    }

    if (slice.nal_ref_idc == 0) return;   // not a reference picture

    if (!slice.adaptive_ref_pic_marking) {
        slidingWindow(sps);
        curr.shortTerm = true;
        return;
    }

    const int32_t currPicNum = (int32_t)slice.frame_num;
    bool currIsLongTerm = false;

    for (const auto& m : slice.mmco) {
        switch (m.op) {
        case 1: {   // a short-term reference becomes unused
            const int32_t picNum = currPicNum - (int32_t)(m.difference_of_pic_nums_minus1 + 1);
            for (auto& p : m_pics)
                if (p.inUse && p.shortTerm && p.frameNumWrap == picNum) p.shortTerm = false;
            break;
        }
        case 2: {   // a long-term reference becomes unused
            for (auto& p : m_pics)
                if (p.inUse && p.longTerm && p.longTermFrameIdx == (int32_t)m.long_term_pic_num)
                    p.longTerm = false;
            break;
        }
        case 3: {   // a short-term reference becomes long-term
            const int32_t picNum = currPicNum - (int32_t)(m.difference_of_pic_nums_minus1 + 1);
            for (auto& p : m_pics)
                if (p.inUse && p.longTerm && p.longTermFrameIdx == (int32_t)m.long_term_frame_idx)
                    p.longTerm = false;
            for (auto& p : m_pics) {
                if (p.inUse && p.shortTerm && p.frameNumWrap == picNum) {
                    p.shortTerm = false;
                    p.longTerm = true;
                    p.longTermFrameIdx = (int32_t)m.long_term_frame_idx;
                }
            }
            break;
        }
        case 4: {   // lower the long-term ceiling
            m_maxLongTermFrameIdx = (int32_t)m.max_long_term_frame_idx_plus1 - 1;
            for (auto& p : m_pics)
                if (p.inUse && p.longTerm && p.longTermFrameIdx > m_maxLongTermFrameIdx)
                    p.longTerm = false;
            break;
        }
        case 5: {   // reset everything, as if this were an IDR
            for (int i = 0; i < m_picCount; i++) {
                if (i == slot) continue;
                m_pics[i].shortTerm = false;
                m_pics[i].longTerm = false;
            }
            m_maxLongTermFrameIdx = -1;
            break;
        }
        case 6: {   // the current picture is long-term
            for (auto& p : m_pics)
                if (p.inUse && p.longTerm && p.longTermFrameIdx == (int32_t)m.long_term_frame_idx)
                    p.longTerm = false;
            curr.longTerm = true;
            curr.longTermFrameIdx = (int32_t)m.long_term_frame_idx;
            currIsLongTerm = true;
            break;
        }
        default: break;
        }
    }

    if (!currIsLongTerm) curr.shortTerm = true;
}

// --- DXVA structures -----------------------------------------------------

void D3D12VideoDecoder::fillPicParams(DXVA_PicParams_H264& pp, const H264SPS& sps,
                                      const H264PPS& pps, const H264SliceHeader& slice,
                                      int slot, int32_t topPoc, int32_t bottomPoc,
                                      bool intraOnly) {
    memset(&pp, 0, sizeof(pp));

    const uint32_t frameHeightInMbs = sps.pic_height_in_map_units * (sps.frame_mbs_only ? 1 : 2);
    pp.wFrameWidthInMbsMinus1 = (USHORT)(sps.pic_width_in_mbs - 1);
    pp.wFrameHeightInMbsMinus1 = (USHORT)(frameHeightInMbs - 1);

    pp.CurrPic.Index7Bits = (UCHAR)slot;
    pp.CurrPic.AssociatedFlag = 0;             // frame coding
    pp.num_ref_frames = sps.max_num_ref_frames;

    // Named bit fields, not a hand-packed wBitFields: chroma_format_idc and
    // weighted_bipred_idc are two bits wide, so packing by hand shifts every
    // flag above them out of place.
    pp.field_pic_flag = 0;
    pp.MbaffFrameFlag = (sps.mb_adaptive_frame_field && !slice.field_pic_flag) ? 1 : 0;
    pp.residual_colour_transform_flag = sps.separate_colour_plane_flag ? 1 : 0;
    pp.sp_for_switch_flag = 0;
    pp.chroma_format_idc = sps.chroma_format_idc;
    pp.RefPicFlag = (slice.nal_ref_idc != 0) ? 1 : 0;
    pp.constrained_intra_pred_flag = pps.constrained_intra_pred ? 1 : 0;
    pp.weighted_pred_flag = pps.weighted_pred ? 1 : 0;
    pp.weighted_bipred_idc = pps.weighted_bipred_idc;
    pp.MbsConsecutiveFlag = (pps.num_slice_groups == 1) ? 1 : 0;
    pp.frame_mbs_only_flag = sps.frame_mbs_only ? 1 : 0;
    pp.transform_8x8_mode_flag = pps.transform_8x8_mode ? 1 : 0;
    pp.MinLumaBipredSize8x8Flag = sps.direct_8x8_inference ? 1 : 0;
    pp.IntraPicFlag = intraOnly ? 1 : 0;

    pp.bit_depth_luma_minus8 = (UCHAR)(sps.bit_depth_luma - 8);
    pp.bit_depth_chroma_minus8 = (UCHAR)(sps.bit_depth_chroma - 8);

    // Drivers read this as a hint about scaling-list ordering; 3 is the value
    // every non-quirked path uses.
    pp.Reserved16Bits = 3;
    pp.StatusReportFeedbackNumber = ++m_statusReport;
    if (pp.StatusReportFeedbackNumber == 0) pp.StatusReportFeedbackNumber = ++m_statusReport;

    // Reference list. RefFrameList, FrameNumList, FieldOrderCntList and
    // UsedForReferenceFlags all share one index: position in this list, not
    // the picture's slot in the pool.
    int n = 0;
    for (int i = 0; i < m_picCount && n < 16; i++) {
        const Picture& p = m_pics[i];
        if (!p.inUse || !p.isReference() || i == slot) continue;

        pp.RefFrameList[n].Index7Bits = (UCHAR)i;
        pp.RefFrameList[n].AssociatedFlag = p.longTerm ? 1 : 0;
        // Short-term entries carry the coded frame_num; the driver derives
        // FrameNumWrap and PicNum from it relative to pp.frame_num. Passing the
        // already-wrapped value makes every reference unresolvable after
        // frame_num wraps, because a negative wrap becomes a huge USHORT.
        pp.FrameNumList[n] = (USHORT)(p.longTerm ? p.longTermFrameIdx : p.frameNum);
        pp.FieldOrderCntList[n][0] = p.topPoc;
        pp.FieldOrderCntList[n][1] = p.bottomPoc;
        pp.UsedForReferenceFlags |= 3u << (2 * n);   // both fields of a frame
        n++;
    }
    for (int i = n; i < 16; i++) pp.RefFrameList[i].bPicEntry = 0xFF;
    // NonExistingFrameFlags stays zero: frame_num gaps are not synthesised,
    // and marking real references as non-existing corrupts prediction.

    pp.CurrFieldOrderCnt[0] = topPoc;
    pp.CurrFieldOrderCnt[1] = bottomPoc;

    pp.pic_init_qs_minus26 = (CHAR)(pps.pic_init_qs - 26);
    pp.chroma_qp_index_offset = (CHAR)pps.chroma_qp_index_offset;
    pp.second_chroma_qp_index_offset = (CHAR)pps.second_chroma_qp_index_offset;
    pp.ContinuationFlag = 1;
    pp.pic_init_qp_minus26 = (CHAR)(pps.pic_init_qp - 26);
    pp.num_ref_idx_l0_active_minus1 =
        (UCHAR)(slice.num_ref_idx_l0_active > 0 ? slice.num_ref_idx_l0_active - 1 : 0);
    pp.num_ref_idx_l1_active_minus1 =
        (UCHAR)(slice.num_ref_idx_l1_active > 0 ? slice.num_ref_idx_l1_active - 1 : 0);

    pp.frame_num = slice.frame_num;
    pp.log2_max_frame_num_minus4 = (UCHAR)(sps.log2_max_frame_num - 4);
    pp.pic_order_cnt_type = sps.pic_order_cnt_type;
    pp.log2_max_pic_order_cnt_lsb_minus4 = (UCHAR)(sps.log2_max_pic_order_cnt_lsb - 4);
    pp.delta_pic_order_always_zero_flag = sps.delta_pic_order_always_zero ? 1 : 0;
    pp.direct_8x8_inference_flag = sps.direct_8x8_inference ? 1 : 0;
    pp.entropy_coding_mode_flag = pps.entropy_coding_mode ? 1 : 0;
    pp.pic_order_present_flag = pps.bottom_field_pic_order_in_frame_present ? 1 : 0;
    pp.num_slice_groups_minus1 = (UCHAR)(pps.num_slice_groups - 1);
    pp.slice_group_map_type = 0;
    pp.deblocking_filter_control_present_flag = pps.deblocking_filter_control_present ? 1 : 0;
    pp.redundant_pic_cnt_present_flag = pps.redundant_pic_cnt_present ? 1 : 0;
    pp.slice_group_change_rate_minus1 = 0;
}

void D3D12VideoDecoder::fillQMatrix(DXVA_Qmatrix_H264& qm, const H264PPS& pps) {
    memset(&qm, 0, sizeof(qm));
    // The parser keeps each list in bitstream (zig-zag) order, which is the
    // order DXVA wants, so these copy straight across.
    for (int i = 0; i < 6; i++) memcpy(qm.bScalingLists4x4[i], pps.scaling_list_4x4[i], 16);
    memcpy(qm.bScalingLists8x8[0], pps.scaling_list_8x8[0], 64);   // 8x8 intra luma
    memcpy(qm.bScalingLists8x8[1], pps.scaling_list_8x8[1], 64);   // 8x8 inter luma
}

// --- Bitstream -----------------------------------------------------------

// Block until the submission that last used this ring slot has finished, so
// its command allocator and its region of the bitstream buffer are both free.
void D3D12VideoDecoder::waitForRing(int ring) {
    if (m_allocFence[ring] == 0) return;
    if (m_fence->GetCompletedValue() >= m_allocFence[ring]) return;
    m_fence->SetEventOnCompletion(m_allocFence[ring], m_fenceEvent);
    WaitForSingleObject(m_fenceEvent, 2000);
}

bool D3D12VideoDecoder::uploadBitstream(const std::vector<H264NalUnit>& slices,
                                        std::vector<DXVA_Slice_H264_Short>& control,
                                        int ring, size_t& bytes) {
    m_staging.clear();
    control.clear();

    for (const auto& nal : slices) {
        // Each entry locates a three-byte start code followed by the NAL, and
        // its length counts from the start code. Rebuilding rather than
        // pointing into the source buffer keeps that true whether the source
        // used three-byte start codes, four-byte ones, or length prefixes.
        DXVA_Slice_H264_Short sc = {};
        sc.BSNALunitDataLocation = (UINT)m_staging.size();
        sc.SliceBytesInBuffer = (UINT)(sizeof(kStartCode) + 1 + nal.size);
        sc.wBadSliceChopping = 0;
        control.push_back(sc);

        m_staging.insert(m_staging.end(), kStartCode, kStartCode + sizeof(kStartCode));
        m_staging.push_back((uint8_t)((nal.nal_ref_idc << 5) | (uint8_t)nal.type));
        m_staging.insert(m_staging.end(), nal.data, nal.data + nal.size);
    }
    if (m_staging.empty()) return false;

    bytes = (m_staging.size() + kBitstreamAlign - 1) & ~(kBitstreamAlign - 1);
    m_staging.resize(bytes, 0);

    if (m_bitstreamStride < bytes) {
        // Growing replaces the whole buffer, so every region has to be idle,
        // not just this one.
        if (m_fenceValue > 0 && m_fence->GetCompletedValue() < m_fenceValue) {
            m_fence->SetEventOnCompletion(m_fenceValue, m_fenceEvent);
            WaitForSingleObject(m_fenceEvent, 2000);
        }
        m_bitstream.Reset();
        // Headroom, so a stream whose frames grow slowly does not reallocate
        // on nearly every picture.
        const size_t want = bytes + bytes / 2;
        m_bitstreamStride = (want + kRegionAlign - 1) & ~(kRegionAlign - 1);

        D3D12_HEAP_PROPERTIES hp = {};
        hp.Type = D3D12_HEAP_TYPE_UPLOAD;
        D3D12_RESOURCE_DESC bd = {};
        bd.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
        bd.Width = m_bitstreamStride * D3D12_DEC_RING;
        bd.Height = 1;
        bd.DepthOrArraySize = 1;
        bd.MipLevels = 1;
        bd.SampleDesc.Count = 1;
        bd.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

        HRESULT hr = m_device->CreateCommittedResource(
            &hp, D3D12_HEAP_FLAG_NONE, &bd, D3D12_RESOURCE_STATE_GENERIC_READ,
            nullptr, IID_PPV_ARGS(&m_bitstream));
        if (FAILED(hr)) {
            printf("[D3D12VDec] bitstream buffer (%zu bytes) creation failed: 0x%08x\n",
                m_bitstreamStride * D3D12_DEC_RING, hr);
            m_bitstreamStride = 0;
            return false;
        }
    }

    const size_t offset = (size_t)ring * m_bitstreamStride;
    uint8_t* mapped = nullptr;
    D3D12_RANGE noRead = { 0, 0 };
    if (FAILED(m_bitstream->Map(0, &noRead, (void**)&mapped)) || !mapped) return false;
    memcpy(mapped + offset, m_staging.data(), bytes);
    D3D12_RANGE written = { offset, offset + bytes };
    m_bitstream->Unmap(0, &written);
    return true;
}

bool D3D12VideoDecoder::submit(const DXVA_PicParams_H264& pp, const DXVA_Qmatrix_H264& qm,
                               const std::vector<DXVA_Slice_H264_Short>& control,
                               size_t bitstreamBytes, int ring, int slot, UINT64& outFence) {
    // waitForRing has already retired this slot, so the allocator is free.
    HRESULT hr = m_alloc[ring]->Reset();
    if (FAILED(hr)) {
        printf("[D3D12VDec] allocator reset failed: 0x%08x\n", hr);
        return false;
    }
    hr = m_cmdList->Reset(m_alloc[ring].Get());
    if (FAILED(hr)) {
        printf("[D3D12VDec] command list reset failed: 0x%08x\n", hr);
        return false;
    }

    D3D12_VIDEO_DECODE_INPUT_STREAM_ARGUMENTS in = {};
    in.pHeap = m_decoderHeap.Get();
    in.NumFrameArguments = 3;
    in.FrameArguments[0].Type = D3D12_VIDEO_DECODE_ARGUMENT_TYPE_PICTURE_PARAMETERS;
    in.FrameArguments[0].Size = sizeof(pp);
    in.FrameArguments[0].pData = (void*)&pp;
    in.FrameArguments[1].Type = D3D12_VIDEO_DECODE_ARGUMENT_TYPE_INVERSE_QUANTIZATION_MATRIX;
    in.FrameArguments[1].Size = sizeof(qm);
    in.FrameArguments[1].pData = (void*)&qm;
    in.FrameArguments[2].Type = D3D12_VIDEO_DECODE_ARGUMENT_TYPE_SLICE_CONTROL;
    in.FrameArguments[2].Size = (UINT)(control.size() * sizeof(DXVA_Slice_H264_Short));
    in.FrameArguments[2].pData = (void*)control.data();

    in.CompressedBitstream.pBuffer = m_bitstream.Get();
    in.CompressedBitstream.Offset = (UINT64)ring * m_bitstreamStride;
    in.CompressedBitstream.Size = bitstreamBytes;

    // The whole pool is passed so that a slot index means the same thing here
    // as it does in CurrPic and RefFrameList.
    in.ReferenceFrames.NumTexture2Ds = m_picCount;
    in.ReferenceFrames.ppTexture2Ds = m_picTextures.data();
    in.ReferenceFrames.pSubresources = m_picSubresources.data();
    in.ReferenceFrames.ppHeaps = nullptr;

    D3D12_VIDEO_DECODE_OUTPUT_STREAM_ARGUMENTS out = {};
    out.pOutputTexture2D = m_pics[slot].tex.Get();
    out.OutputSubresource = 0;
    out.ConversionArguments.Enable = FALSE;

    m_cmdList->DecodeFrame(m_decoder.Get(), &out, &in);

    hr = m_cmdList->Close();
    if (FAILED(hr)) {
        printf("[D3D12VDec] command list close failed: 0x%08x\n", hr);
        return false;
    }

    ID3D12CommandList* lists[] = { m_cmdList.Get() };
    m_queue->ExecuteCommandLists(1, lists);

    outFence = ++m_fenceValue;
    if (FAILED(m_queue->Signal(m_fence.Get(), outFence))) return false;

    m_allocFence[ring] = outFence;
    return true;
}

// --- Decode --------------------------------------------------------------

D3D12DecodedPicture D3D12VideoDecoder::decode(const uint8_t* data, size_t size, double pts) {
    D3D12DecodedPicture result;
    m_lastFailed = false;
    if (!m_initialized || !data || size == 0) return result;

    // MF hands MP4 samples over as Annex B; the length-prefixed form is the
    // fallback for a source that passes the avcC framing through untouched.
    auto nals = H264Parser::findNalUnitsAnnexB(data, size);
    if (nals.empty()) nals = H264Parser::findNalUnitsAVCC(data, size, 4);
    if (nals.empty()) {
        printf("[D3D12VDec] no NAL units in a %zu byte sample (starts %02x %02x %02x %02x)\n",
            size, size > 0 ? data[0] : 0, size > 1 ? data[1] : 0,
            size > 2 ? data[2] : 0, size > 3 ? data[3] : 0);
        m_lastFailed = true;
        return result;
    }

    ingestParameterSets(nals);

    std::vector<H264NalUnit> slices;
    for (const auto& nal : nals) if (isSliceNal(nal.type)) slices.push_back(nal);
    if (slices.empty()) return result;   // parameter sets only: not a failure

    const H264NalUnit& first = slices.front();

    // Peek at the slice header for its PPS id, which selects the SPS.
    H264Bitstream peek(first.data, first.size);
    peek.readUE();                       // first_mb_in_slice
    peek.readUE();                       // slice_type
    const uint32_t ppsId = peek.readUE();
    if (peek.overrun() || ppsId >= m_pps.size() || !m_pps[ppsId].valid) {
        if (m_verbose) printf("[D3D12VDec] no PPS %u yet; skipping sample\n", ppsId);
        return result;
    }
    const H264PPS& pps = m_pps[ppsId];
    if (pps.sps_id >= m_sps.size() || !m_sps[pps.sps_id].valid) return result;
    const H264SPS& sps = m_sps[pps.sps_id];

    // Checked per picture, not once at startup: a stream can carry several
    // parameter sets and activate a different one part-way through, and the
    // one this picture names is the only one that matters.
    const char* why = nullptr;
    if (!spsSupported(sps, &why)) {
        printf("[D3D12VDec] %s; cannot decode this stream\n", why);
        m_lastFailed = true;
        return result;
    }

    if (!m_decoder || !m_decoderHeap || !m_pics[0].tex) {
        if (!applySPS(sps)) { m_lastFailed = true; return result; }
    }

    H264SliceHeader slice;
    if (!H264Parser::parseSliceHeader(first, sps, pps, slice)) {
        printf("[D3D12VDec] slice header parse failed\n");
        m_lastFailed = true;
        return result;
    }
    if (slice.field_pic_flag) {
        printf("[D3D12VDec] field pictures are not supported\n");
        m_lastFailed = true;
        return result;
    }

    bool intraOnly = true;
    for (const auto& nal : slices) {
        H264Bitstream b(nal.data, nal.size);
        b.readUE();
        const uint32_t t = b.readUE() % 5;
        if (t != SLICE_I && t != SLICE_SI) { intraOnly = false; break; }
    }

    // Nothing has been decoded since the last flush, so the buffer this
    // picture would predict from is empty. Submitting it anyway hands the
    // hardware an empty reference list; wait for a picture that stands alone.
    if (m_awaitingRecovery) {
        if (!slice.idr && !intraOnly) {
            if (m_verbose) printf("[D3D12VDec] waiting for a recovery point, dropping a picture\n");
            return result;
        }
        m_awaitingRecovery = false;
    }

    if (slice.idr) resetDpb();

    updateFrameNumWrap((int32_t)slice.frame_num, sps.maxFrameNum());

    int32_t topPoc = 0, bottomPoc = 0;
    computePoc(sps, slice, topPoc, bottomPoc);

    const int slot = allocPicture();
    if (slot < 0) {
        // Every picture is either a live reference or still on screen. This
        // means the pool is undersized for the stream, not a transient.
        printf("[D3D12VDec] picture pool exhausted (%d slots)\n", m_picCount);
        m_lastFailed = true;
        return result;
    }

    DXVA_PicParams_H264 pp;
    fillPicParams(pp, sps, pps, slice, slot, topPoc, bottomPoc, intraOnly);

    DXVA_Qmatrix_H264 qm;
    fillQMatrix(qm, pps);

    // One ring slot covers both the command allocator and the region of the
    // bitstream buffer, so retiring it once makes both safe to overwrite.
    const int ring = m_ring;
    waitForRing(ring);

    std::vector<DXVA_Slice_H264_Short> control;
    size_t bitstreamBytes = 0;
    if (!uploadBitstream(slices, control, ring, bitstreamBytes)) {
        m_lastFailed = true;
        return result;
    }

    UINT64 fenceValue = 0;
    if (!submit(pp, qm, control, bitstreamBytes, ring, slot, fenceValue)) {
        m_lastFailed = true;
        return result;
    }
    m_ring = (ring + 1) % D3D12_DEC_RING;

    Picture& picture = m_pics[slot];
    picture.inUse = true;
    picture.heldByClient = true;
    picture.frameNum = (int32_t)slice.frame_num;
    picture.frameNumWrap = (int32_t)slice.frame_num;
    picture.topPoc = topPoc;
    picture.bottomPoc = bottomPoc;
    picture.shortTerm = false;
    picture.longTerm = false;

    // Marking happens after the picture exists, per 8.2.5: an MMCO can retire
    // a reference the picture being decoded still needed.
    markReferences(sps, slice, slot);

    // 8.2.1: after MMCO 5 the picture is held as though its frame_num were
    // zero and its count rebased to zero, and that is what later pictures
    // measure themselves against.
    const bool hadMMCO5 = slice.hasMMCO5();
    if (hadMMCO5) {
        const int32_t base = (picture.topPoc < picture.bottomPoc)
            ? picture.topPoc : picture.bottomPoc;
        picture.topPoc -= base;
        picture.bottomPoc -= base;
        picture.frameNum = 0;
        picture.frameNumWrap = 0;
    }
    // Only a reference picture supplies the previous state, so a non-reference
    // picture in between must not clear the flag the next reference reads.
    if (slice.nal_ref_idc != 0) m_prevHadMMCO5 = hadMMCO5;

    if (m_verbose) {
        printf("[D3D12VDec] slot %2d  frame_num=%-5u poc=%-6d %s %zu slice(s) %zu bytes t=%.3f\n",
            slot, slice.frame_num, topPoc, slice.idr ? "IDR" : (intraOnly ? "I  " : "P/B"),
            control.size(), bitstreamBytes, pts);
    }

    result.texture = picture.tex.Get();
    result.width = m_dispWidth;
    result.height = m_dispHeight;
    result.codedWidth = m_codedWidth;
    result.codedHeight = m_codedHeight;
    result.pts = pts;
    result.fenceValue = fenceValue;
    result.valid = true;
    return result;
}

// --- Shutdown ------------------------------------------------------------

void D3D12VideoDecoder::shutdown() {
    if (!m_initialized) return;

    if (m_fence && m_queue && m_fenceEvent) {
        const UINT64 final = ++m_fenceValue;
        if (SUCCEEDED(m_queue->Signal(m_fence.Get(), final)) &&
            m_fence->GetCompletedValue() < final) {
            m_fence->SetEventOnCompletion(final, m_fenceEvent);
            WaitForSingleObject(m_fenceEvent, 5000);
        }
    }

    m_cmdList.Reset();
    for (auto& a : m_alloc) a.Reset();
    m_queue.Reset();
    m_decoderHeap.Reset();
    m_decoder.Reset();
    m_fence.Reset();
    m_bitstream.Reset();
    m_bitstreamStride = 0;
    m_videoDevice.Reset();
    for (auto& p : m_pics) { p.tex.Reset(); p = Picture{}; }
    m_picTextures.fill(nullptr);
    m_picCount = 0;
    m_framePool = 4;
    m_reorderDepth = 0;
    m_spsRefused = false;
    m_awaitingRecovery = true;

    if (m_fenceEvent) { CloseHandle(m_fenceEvent); m_fenceEvent = nullptr; }

    m_device = nullptr;
    m_haveParameterSets = false;
    m_initialized = false;
}
