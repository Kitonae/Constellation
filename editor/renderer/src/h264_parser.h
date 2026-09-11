#pragma once
// H.264 (AVC) NAL unit parser for D3D12 / DXVA hardware decode.
//
// Parses SPS, PPS and slice headers far enough to fill DXVA_PicParams_H264,
// DXVA_Qmatrix_H264 and DXVA_Slice_H264_Short for submission to
// ID3D12VideoDecodeCommandList::DecodeFrame.
//
// Slice *data* is never parsed: with the short slice control format the
// hardware reads the macroblock layer straight out of the bitstream buffer.
// What the host must supply is everything the hardware cannot infer -- the
// active parameter sets, the picture order count, and the state of the
// decoded picture buffer -- which is exactly what the slice header carries.
//
// Supports Baseline, Main and High profiles, frame coding only; interlaced
// streams are rejected upstream rather than half-handled here.

#include <cstdint>
#include <cstddef>
#include <cstring>
#include <vector>

// NAL unit types (Table 7-1)
enum H264NalType : uint8_t {
    NAL_SLICE       = 1,   // coded slice of a non-IDR picture
    NAL_DPA         = 2,   // coded slice data partition A
    NAL_DPB_PART    = 3,
    NAL_DPC         = 4,
    NAL_IDR_SLICE   = 5,   // coded slice of an IDR picture
    NAL_SEI         = 6,
    NAL_SPS         = 7,
    NAL_PPS         = 8,
    NAL_AUD         = 9,   // access unit delimiter
    NAL_END_SEQ     = 10,
    NAL_END_STREAM  = 11,
    NAL_FILLER      = 12,
    NAL_SPS_EXT     = 13,
    NAL_PREFIX      = 14,
    NAL_SUBSET_SPS  = 15,
};

// slice_type values 5..9 mean "all slices in this picture have this type";
// sliceTypeNormalized folds them back onto 0..4.
enum H264SliceType : uint8_t {
    SLICE_P  = 0,
    SLICE_B  = 1,
    SLICE_I  = 2,
    SLICE_SP = 3,
    SLICE_SI = 4,
};

// Memory management control operation (7.4.3.3)
struct H264MMCO {
    uint8_t  op = 0;
    uint32_t difference_of_pic_nums_minus1 = 0;
    uint32_t long_term_pic_num = 0;
    uint32_t long_term_frame_idx = 0;
    uint32_t max_long_term_frame_idx_plus1 = 0;
};

struct H264SPS {
    bool     valid = false;
    uint8_t  profile_idc = 0;
    uint8_t  level_idc = 0;
    uint8_t  sps_id = 0;

    // Chroma / bit depth (High profile and above)
    uint8_t  chroma_format_idc = 1;          // 1 = 4:2:0
    bool     separate_colour_plane_flag = false;
    uint8_t  bit_depth_luma = 8;
    uint8_t  bit_depth_chroma = 8;
    bool     qpprime_y_zero_transform_bypass = false;

    bool     seq_scaling_matrix_present = false;
    uint8_t  scaling_list_4x4[6][16] = {};
    uint8_t  scaling_list_8x8[6][64] = {};

    uint8_t  log2_max_frame_num = 4;         // log2_max_frame_num_minus4 + 4
    uint8_t  pic_order_cnt_type = 0;
    uint8_t  log2_max_pic_order_cnt_lsb = 4; // log2_max_pic_order_cnt_lsb_minus4 + 4
    bool     delta_pic_order_always_zero = false;
    int32_t  offset_for_non_ref_pic = 0;
    int32_t  offset_for_top_to_bottom_field = 0;
    uint8_t  num_ref_frames_in_poc_cycle = 0;
    int32_t  offset_for_ref_frame[255] = {};
    uint8_t  max_num_ref_frames = 0;
    bool     gaps_in_frame_num_allowed = false;

    uint32_t pic_width_in_mbs = 0;           // pic_width_in_mbs_minus1 + 1
    uint32_t pic_height_in_map_units = 0;    // pic_height_in_map_units_minus1 + 1
    bool     frame_mbs_only = true;
    bool     mb_adaptive_frame_field = false;
    bool     direct_8x8_inference = false;

    bool     frame_cropping = false;
    uint32_t crop_left = 0, crop_right = 0, crop_top = 0, crop_bottom = 0;

    uint32_t maxFrameNum() const { return 1u << log2_max_frame_num; }
    uint32_t maxPocLsb() const { return 1u << log2_max_pic_order_cnt_lsb; }

    // Coded size, before cropping. The decoder allocates at this size because
    // that is what the hardware writes; cropping is a display-time concern.
    uint32_t codedWidth() const { return pic_width_in_mbs * 16; }
    uint32_t codedHeight() const {
        return pic_height_in_map_units * 16 * (frame_mbs_only ? 1 : 2);
    }
    uint32_t displayWidth() const {
        uint32_t w = codedWidth();
        if (frame_cropping) {
            uint32_t subW = (chroma_format_idc == 3 || chroma_format_idc == 0) ? 1 : 2;
            uint32_t crop = (crop_left + crop_right) * subW;
            w = (crop < w) ? w - crop : w;
        }
        return w;
    }
    uint32_t displayHeight() const {
        uint32_t h = codedHeight();
        if (frame_cropping) {
            uint32_t subH = (chroma_format_idc == 1) ? 2 : 1;
            uint32_t units = frame_mbs_only ? 1 : 2;
            uint32_t crop = (crop_top + crop_bottom) * subH * units;
            h = (crop < h) ? h - crop : h;
        }
        return h;
    }
};

struct H264PPS {
    bool     valid = false;
    uint8_t  pps_id = 0;
    uint8_t  sps_id = 0;
    bool     entropy_coding_mode = false;    // 0 = CAVLC, 1 = CABAC
    bool     bottom_field_pic_order_in_frame_present = false;
    uint8_t  num_slice_groups = 1;           // num_slice_groups_minus1 + 1

    uint8_t  num_ref_idx_l0_default = 1;
    uint8_t  num_ref_idx_l1_default = 1;

    bool     weighted_pred = false;
    uint8_t  weighted_bipred_idc = 0;
    int8_t   pic_init_qp = 26;               // pic_init_qp_minus26 + 26
    int8_t   pic_init_qs = 26;
    int8_t   chroma_qp_index_offset = 0;
    bool     deblocking_filter_control_present = false;
    bool     constrained_intra_pred = false;
    bool     redundant_pic_cnt_present = false;

    // High profile extension (present only when more_rbsp_data says so)
    bool     transform_8x8_mode = false;
    bool     pic_scaling_matrix_present = false;
    int8_t   second_chroma_qp_index_offset = 0;

    uint8_t  scaling_list_4x4[6][16] = {};
    uint8_t  scaling_list_8x8[6][64] = {};
};

struct H264SliceHeader {
    uint32_t first_mb_in_slice = 0;
    uint8_t  slice_type = 0;                 // raw slice_type, 0..9
    uint8_t  pps_id = 0;
    uint8_t  colour_plane_id = 0;
    uint16_t frame_num = 0;
    bool     field_pic_flag = false;
    bool     bottom_field_flag = false;
    uint16_t idr_pic_id = 0;

    uint32_t pic_order_cnt_lsb = 0;
    int32_t  delta_pic_order_cnt_bottom = 0;
    int32_t  delta_pic_order_cnt[2] = {};

    uint8_t  num_ref_idx_l0_active = 0;
    uint8_t  num_ref_idx_l1_active = 0;

    // dec_ref_pic_marking()
    bool     no_output_of_prior_pics = false;
    bool     long_term_reference_flag = false;   // IDR only
    bool     adaptive_ref_pic_marking = false;
    std::vector<H264MMCO> mmco;

    // From the NAL header, carried here so callers need only the slice.
    bool     idr = false;
    uint8_t  nal_ref_idc = 0;

    uint8_t sliceTypeNormalized() const { return (uint8_t)(slice_type % 5); }
    bool isIntraOnly() const {
        uint8_t t = sliceTypeNormalized();
        return t == SLICE_I || t == SLICE_SI;
    }
    bool isReference() const { return nal_ref_idc > 0; }
    /** Does this picture reset the whole DPB? */
    bool isIDR() const { return idr; }
    /** MMCO 5 resets picture order counts as if the picture were an IDR. */
    bool hasMMCO5() const {
        for (const auto& m : mmco) if (m.op == 5) return true;
        return false;
    }
};

// A located NAL unit. `data`/`size` cover the payload after the header byte;
// `offset`/`totalSize` locate the whole NAL, start code included, inside the
// buffer it was found in -- which is what the slice control structures index.
struct H264NalUnit {
    H264NalType    type = NAL_SLICE;
    uint8_t        nal_ref_idc = 0;
    const uint8_t* data = nullptr;
    size_t         size = 0;
    size_t         offset = 0;      // offset of the start code
    size_t         startCodeLen = 0;
    size_t         totalSize = 0;   // start code + header byte + payload
};

class H264Parser {
public:
    /** NAL units in an Annex B byte stream (3- or 4-byte start codes). */
    static std::vector<H264NalUnit> findNalUnitsAnnexB(const uint8_t* data, size_t size);

    /** NAL units in AVCC / length-prefixed form, as carried in an avcC box. */
    static std::vector<H264NalUnit> findNalUnitsAVCC(const uint8_t* data, size_t size,
                                                     int lengthSize = 4);

    static bool parseSPS(const uint8_t* data, size_t size, H264SPS& sps);
    static bool parsePPS(const uint8_t* data, size_t size, const H264SPS& sps, H264PPS& pps);

    /**
     * Slice header, up to and including dec_ref_pic_marking.
     *
     * Everything between the POC fields and the marking syntax -- reference
     * list modification and the prediction weight table -- has to be parsed
     * in order to be skipped, because none of it is fixed length.
     */
    static bool parseSliceHeader(const H264NalUnit& nal,
                                 const H264SPS& sps, const H264PPS& pps,
                                 H264SliceHeader& slice);
};
