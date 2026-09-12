#pragma once
// H.264 decode on the D3D12 video engine, with no D3D11 and no Media
// Foundation decoder in the path.
//
//   MF source reader (demux only) -> H264Parser -> DXVA picture parameters
//   -> ID3D12VideoDecodeCommandList::DecodeFrame -> NV12 texture -> SRV
//
// The output of DecodeFrame is a picture in this decoder's own pool, and the
// same texture serves as a reference frame for later pictures and as the
// texture the renderer samples. Nothing is copied: the caller borrows the
// texture and calls releasePicture when the renderer has finished with it.
//
// Every picture is created with ALLOW_SIMULTANEOUS_ACCESS. That is what makes
// it legal for the render queue to sample a frame while the decode queue is
// still reading the same texture as a reference: the resource decays to the
// common state after each submission and is implicitly promoted to a
// read-only state on each queue, so no barriers are needed and neither queue
// has to know what the other is doing with it.
//
// Frame coding only. Interlaced streams, and hardware that demands
// reference-only allocations or decode tier 1, are refused at init so the
// caller falls back to the D3D11On12 path rather than decoding them wrongly.

#include "h264_parser.h"

#include <d3d12.h>
#include <d3d12video.h>
#include <dxva.h>
#include <wrl/client.h>
#include <array>
#include <cstdint>
#include <vector>

using Microsoft::WRL::ComPtr;

// Ceiling on the picture pool: 16 reference frames, the pictures the renderer
// is holding, and the one being decoded. The pool is actually sized per stream
// from the SPS (see picCount()), because committing the ceiling for every clip
// costs ~140 MB at 1080p and ~440 MB at 4K whatever the stream needs.
inline constexpr int D3D12_DEC_PIC_POOL_MAX = 32;

// Decode submissions in flight before the CPU has to wait for the oldest.
inline constexpr int D3D12_DEC_RING = 4;

/** One decoded picture handed to the caller. */
struct D3D12DecodedPicture {
    ID3D12Resource* texture = nullptr;   // NV12, borrowed; release with releasePicture
    uint32_t width = 0;                  // cropped, for display
    uint32_t height = 0;
    uint32_t codedWidth = 0;             // allocated, for SRV sizing
    uint32_t codedHeight = 0;
    double   pts = -1.0;
    UINT64   fenceValue = 0;             // render queue must Wait for this
    bool     valid = false;
};

class D3D12VideoDecoder {
public:
    ~D3D12VideoDecoder();

    /**
     * Can this device decode H.264 at this size the way this class needs?
     *
     * Stricter than "the profile is supported": decode tier 1 keeps every
     * reference frame in one texture array and reference-only allocations
     * cannot be sampled, and neither fits the zero-copy pool below.
     */
    static bool isSupported(ID3D12Device* device, uint32_t width, uint32_t height);

    /**
     * @param seqHeader Optional out-of-band parameter sets (MF hands these
     *        over as MF_MT_MPEG_SEQUENCE_HEADER). Streams that repeat SPS/PPS
     *        in band do not need them, but a stream that does not would
     *        otherwise never decode its first picture.
     */
    bool init(ID3D12Device* device, uint32_t width, uint32_t height,
              const uint8_t* seqHeader = nullptr, size_t seqHeaderSize = 0);

    /**
     * Decode one access unit.
     *
     * `data` is one MF sample, either Annex B or length-prefixed; which one is
     * worked out from the data. Returns an invalid picture for a sample that
     * carries no slices (parameter sets only) as well as for a genuine
     * failure; check `failed()` to tell the two apart.
     */
    D3D12DecodedPicture decode(const uint8_t* data, size_t size, double pts);

    /** Give a picture back once the renderer has finished sampling it. */
    void releasePicture(ID3D12Resource* texture);

    /**
     * How many frames the caller should keep in its own pool.
     *
     * Pictures come out in decode order, so the caller has to be able to hold
     * a whole reorder window at once; a pool shallower than that blocks the
     * decode thread before the picture it is waiting for has been decoded.
     */
    int framePoolSize() const { return m_framePool; }

    /** Drop all decoded state. Called on seek, before the first new IDR. */
    void flush();

    /** Did the last decode call fail (as opposed to having nothing to do)? */
    bool failed() const { return m_lastFailed; }

    ID3D12Fence* fence() const { return m_fence.Get(); }

    // Sizes from the active SPS; zero until the first parameter set arrives.
    uint32_t width() const { return m_dispWidth; }
    uint32_t height() const { return m_dispHeight; }

    /**
     * The parameter set the decoder is configured for.
     *
     * Its VUI is the only description of the colour signal on this path: with
     * the Media Foundation decoder bypassed there is no output media type to
     * read a nominal range or matrix off.
     */
    const H264SPS& activeSPS() const { return m_activeSps; }

    void setVerbose(bool v) { m_verbose = v; }
    void shutdown();

private:
    struct Picture {
        ComPtr<ID3D12Resource> tex;
        bool     inUse = false;          // holds a decoded picture
        bool     shortTerm = false;      // marked as a short-term reference
        bool     longTerm = false;
        bool     heldByClient = false;   // handed out, must not be reused
        int32_t  frameNum = 0;
        int32_t  frameNumWrap = 0;
        int32_t  longTermFrameIdx = 0;
        int32_t  topPoc = 0;
        int32_t  bottomPoc = 0;
        bool isReference() const { return shortTerm || longTerm; }
    };

    static bool spsSupported(const H264SPS& sps, const char** why);
    bool createPictures(uint32_t codedWidth, uint32_t codedHeight);
    bool createDecoder(uint32_t codedWidth, uint32_t codedHeight);
    void ingestParameterSets(const std::vector<H264NalUnit>& nals);
    bool applySPS(const H264SPS& sps);

    int  allocPicture();
    void resetDpb();
    void updateFrameNumWrap(int32_t currFrameNum, uint32_t maxFrameNum);
    void computePoc(const H264SPS& sps, const H264SliceHeader& slice,
                    int32_t& topPoc, int32_t& bottomPoc);
    void markReferences(const H264SPS& sps, const H264SliceHeader& slice, int slot);
    void slidingWindow(const H264SPS& sps);

    void fillPicParams(DXVA_PicParams_H264& pp, const H264SPS& sps, const H264PPS& pps,
                       const H264SliceHeader& slice, int slot,
                       int32_t topPoc, int32_t bottomPoc, bool intraOnly);
    void fillQMatrix(DXVA_Qmatrix_H264& qm, const H264PPS& pps);

    void waitForRing(int ring);
    bool uploadBitstream(const std::vector<H264NalUnit>& slices,
                         std::vector<DXVA_Slice_H264_Short>& control,
                         int ring, size_t& bytes);
    bool submit(const DXVA_PicParams_H264& pp, const DXVA_Qmatrix_H264& qm,
                const std::vector<DXVA_Slice_H264_Short>& control,
                size_t bitstreamBytes, int ring, int slot, UINT64& outFence);

    ID3D12Device* m_device = nullptr;   // borrowed from App

    ComPtr<ID3D12VideoDevice>            m_videoDevice;
    ComPtr<ID3D12VideoDecoder>           m_decoder;
    ComPtr<ID3D12VideoDecoderHeap>       m_decoderHeap;
    ComPtr<ID3D12CommandQueue>           m_queue;
    ComPtr<ID3D12VideoDecodeCommandList> m_cmdList;
    std::array<ComPtr<ID3D12CommandAllocator>, D3D12_DEC_RING> m_alloc;
    std::array<UINT64, D3D12_DEC_RING> m_allocFence = {};
    int m_ring = 0;

    ComPtr<ID3D12Fence> m_fence;
    UINT64 m_fenceValue = 0;
    HANDLE m_fenceEvent = nullptr;

    // One upload buffer holding D3D12_DEC_RING regions. The GPU reads the
    // compressed bitstream for the whole of a decode, so a single shared
    // region would be overwritten by the next submission while the previous
    // one was still reading it -- which decodes cleanly only when the caller
    // happens to wait between frames.
    ComPtr<ID3D12Resource> m_bitstream;      // upload heap
    size_t m_bitstreamStride = 0;            // bytes per ring region
    std::vector<uint8_t> m_staging;          // bitstream assembled here first

    std::array<Picture, D3D12_DEC_PIC_POOL_MAX> m_pics;
    std::array<ID3D12Resource*, D3D12_DEC_PIC_POOL_MAX> m_picTextures = {};
    std::array<UINT, D3D12_DEC_PIC_POOL_MAX> m_picSubresources = {};
    int m_picCount = 0;        // pictures actually allocated, from the SPS
    int m_framePool = 4;       // frames the caller should pool
    int m_reorderDepth = 0;

    // Parameter sets, by id. H.264 allows 32 SPS and 256 PPS.
    std::array<H264SPS, 32> m_sps;
    std::array<H264PPS, 256> m_pps;
    bool m_haveParameterSets = false;

    // Picture order count state carried between pictures (8.2.1)
    int32_t m_prevPocMsb = 0;
    int32_t m_prevPocLsb = 0;
    int32_t m_prevFrameNumOffset = 0;
    int32_t m_prevFrameNum = 0;
    bool    m_prevHadMMCO5 = false;
    int32_t m_maxLongTermFrameIdx = -1;

    uint32_t m_codedWidth = 0;
    uint32_t m_codedHeight = 0;
    uint32_t m_dispWidth = 0;
    uint32_t m_dispHeight = 0;
    H264SPS  m_activeSps;
    UINT     m_statusReport = 0;

    // Set when a parameter set describes something this decoder cannot do, so
    // the refusal survives to the next decode call instead of being recomputed
    // and forgotten. init() reports it and the caller falls back.
    bool m_spsRefused = false;

    // After a flush the decoded picture buffer is empty, so a picture that
    // predicts from it would reference nothing. Pictures are dropped until a
    // recovery point -- an IDR, or an intra picture for an open-GOP stream.
    bool m_awaitingRecovery = true;

    bool m_initialized = false;
    bool m_lastFailed = false;
    bool m_verbose = false;
};
