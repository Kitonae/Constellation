#include "h264_parser.h"
#include "h264_bitstream.h"
#include <algorithm>

// --- NAL unit location ---------------------------------------------------

static H264NalUnit makeNal(const uint8_t* base, size_t startCodeOffset,
                           size_t startCodeLen, size_t nalBytes) {
    H264NalUnit nal = {};
    const uint8_t* nalStart = base + startCodeOffset + startCodeLen;
    if (nalBytes == 0) return nal;

    nal.nal_ref_idc = (uint8_t)((nalStart[0] >> 5) & 0x03);
    nal.type = (H264NalType)(nalStart[0] & 0x1F);
    nal.data = nalStart + 1;
    nal.size = nalBytes - 1;
    nal.offset = startCodeOffset;
    nal.startCodeLen = startCodeLen;
    nal.totalSize = startCodeLen + nalBytes;
    return nal;
}

std::vector<H264NalUnit> H264Parser::findNalUnitsAnnexB(const uint8_t* data, size_t size) {
    std::vector<H264NalUnit> nals;
    if (!data || size < 4) return nals;

    // Offsets of every start code, with its length. A 4-byte start code is a
    // zero byte followed by a 3-byte one, so the leading zero is folded in
    // here rather than being left at the tail of the previous NAL.
    size_t scOffset = 0, scLen = 0;
    bool have = false;

    for (size_t i = 0; i + 2 < size; ) {
        if (!(data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1)) { i++; continue; }

        size_t thisOffset = i;
        size_t thisLen = 3;
        if (i > 0 && data[i - 1] == 0) { thisOffset = i - 1; thisLen = 4; }

        if (have) {
            size_t nalBytes = thisOffset - (scOffset + scLen);
            if (nalBytes > 0) nals.push_back(makeNal(data, scOffset, scLen, nalBytes));
        }
        scOffset = thisOffset;
        scLen = thisLen;
        have = true;
        i += 3;
    }

    if (have) {
        size_t payloadStart = scOffset + scLen;
        if (payloadStart < size) {
            // Trailing zero bytes are cabac_zero_words or padding, not payload.
            size_t end = size;
            while (end > payloadStart && data[end - 1] == 0) end--;
            if (end > payloadStart)
                nals.push_back(makeNal(data, scOffset, scLen, end - payloadStart));
        }
    }
    return nals;
}

std::vector<H264NalUnit> H264Parser::findNalUnitsAVCC(const uint8_t* data, size_t size,
                                                      int lengthSize) {
    std::vector<H264NalUnit> nals;
    if (!data || lengthSize < 1 || lengthSize > 4) return nals;

    size_t pos = 0;
    while (pos + (size_t)lengthSize <= size) {
        uint32_t nalLen = 0;
        for (int i = 0; i < lengthSize; i++) nalLen = (nalLen << 8) | data[pos + i];
        size_t payload = pos + lengthSize;
        if (nalLen == 0 || payload + nalLen > size) break;

        // The length prefix stands in for the start code, so a caller
        // rewriting the stream sees the same offset/totalSize contract.
        nals.push_back(makeNal(data, pos, (size_t)lengthSize, nalLen));
        pos = payload + nalLen;
    }
    return nals;
}

// --- Scaling lists -------------------------------------------------------

static const uint8_t kDefault4x4Intra[16] = {
     6,13,13,20,20,20,28,28,28,28,32,32,32,37,37,42
};
static const uint8_t kDefault4x4Inter[16] = {
    10,14,14,20,20,20,24,24,24,24,27,27,27,30,30,34
};
// Every list here is in scan (zig-zag) order, which is how the bitstream
// codes them and how DXVA wants them, so a parsed list and a default list are
// interchangeable. Table 7-4 prints the 8x8 defaults as a raster matrix, so
// these are that matrix permuted once rather than at every use -- copying the
// printed form straight across silently dequantises High-profile streams that
// select the default 8x8 matrices with the wrong coefficients.
static const uint8_t kDefault8x8Intra[64] = {
     6,10,10,13,11,13,16,16,
    16,16,18,18,18,18,18,23,
    23,23,23,23,23,25,25,25,
    25,25,25,25,27,27,27,27,
    27,27,27,27,29,29,29,29,
    29,29,29,31,31,31,31,31,
    31,33,33,33,33,33,36,36,
    36,36,38,38,38,40,40,42
};
static const uint8_t kDefault8x8Inter[64] = {
     9,13,13,15,13,15,17,17,
    17,17,19,19,19,19,19,21,
    21,21,21,21,21,22,22,22,
    22,22,22,22,24,24,24,24,
    24,24,24,24,25,25,25,25,
    25,25,25,27,27,27,27,27,
    27,28,28,28,28,28,30,30,
    30,30,32,32,32,33,33,35
};
static const uint8_t kFlat[64] = {
    16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
    16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
    16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,
    16,16,16,16,16,16,16,16,16,16,16,16,16,16,16,16
};

static const uint8_t* defaultList(int i, int listSize) {
    if (listSize == 16) return (i < 3) ? kDefault4x4Intra : kDefault4x4Inter;
    return (i % 2 == 0) ? kDefault8x8Intra : kDefault8x8Inter;
}

// 7.3.2.1.1.1. `useDefault` reports scaling_list_present_flag being set but
// the list decoding to "use the default" (delta makes nextScale zero at j=0).
static void parseScalingList(H264Bitstream& bs, uint8_t* list, int listSize, bool& useDefault) {
    int lastScale = 8, nextScale = 8;
    useDefault = false;
    for (int j = 0; j < listSize; j++) {
        if (nextScale != 0) {
            int delta = bs.readSE();
            nextScale = (lastScale + delta + 256) % 256;
            if (j == 0 && nextScale == 0) { useDefault = true; return; }
        }
        list[j] = (uint8_t)((nextScale == 0) ? lastScale : nextScale);
        lastScale = list[j];
    }
}

// Fill one scaling matrix, applying the fall-back rules of Table 7-2: a list
// that is not present inherits from the previous list of its kind, except at
// the start of each set where it falls back to the default.
static void parseScalingMatrix(H264Bitstream& bs, int numLists,
                               uint8_t list4x4[6][16], uint8_t list8x8[6][64],
                               const uint8_t fallback4x4[6][16],
                               const uint8_t fallback8x8[6][64]) {
    for (int i = 0; i < numLists; i++) {
        uint8_t* dst = (i < 6) ? list4x4[i] : list8x8[i - 6];
        int listSize = (i < 6) ? 16 : 64;
        bool present = bs.readBit() != 0;
        if (present) {
            bool useDefault = false;
            parseScalingList(bs, dst, listSize, useDefault);
            if (useDefault) memcpy(dst, defaultList(i < 6 ? i : i - 6, listSize), listSize);
            continue;
        }
        // Not present: fall back.
        if (i == 0 || i == 3 || i == 6 || i == 7) {
            const uint8_t* src = (i < 6)
                ? (fallback4x4 ? fallback4x4[i] : defaultList(i, 16))
                : (fallback8x8 ? fallback8x8[i - 6] : defaultList(i - 6, 64));
            memcpy(dst, src, listSize);
        } else if (i < 6) {
            memcpy(dst, list4x4[i - 1], 16);
        } else {
            memcpy(dst, list8x8[i - 6 - 2], 64);
        }
    }
}

static void fillFlat(uint8_t list4x4[6][16], uint8_t list8x8[6][64]) {
    for (int i = 0; i < 6; i++) memcpy(list4x4[i], kFlat, 16);
    for (int i = 0; i < 6; i++) memcpy(list8x8[i], kFlat, 64);
}

// --- VUI -----------------------------------------------------------------

// E.1.2. Parsed for two things the renderer needs -- the colour signal and the
// reorder depth -- and skipped past for everything else. None of it is fixed
// length, so the tail cannot be reached without walking the head.
static void parseVUI(H264Bitstream& bs, H264SPS& sps) {
    if (bs.readBit()) {                       // aspect_ratio_info_present_flag
        const uint32_t idc = bs.readBits(8);
        if (idc == 255) { bs.readBits(16); bs.readBits(16); }   // Extended_SAR
    }
    if (bs.readBit()) bs.readBit();           // overscan_info -> overscan_appropriate

    if (bs.readBit()) {                       // video_signal_type_present_flag
        bs.readBits(3);                       // video_format
        sps.video_full_range = bs.readBit() != 0;
        if (bs.readBit()) {                   // colour_description_present_flag
            sps.colour_description_present = true;
            sps.colour_primaries = (uint8_t)bs.readBits(8);
            sps.transfer_characteristics = (uint8_t)bs.readBits(8);
            sps.matrix_coefficients = (uint8_t)bs.readBits(8);
        }
    }

    if (bs.readBit()) { bs.readUE(); bs.readUE(); }   // chroma_loc top/bottom

    if (bs.readBit()) {                       // timing_info_present_flag
        bs.readBits(32);                      // num_units_in_tick
        bs.readBits(32);                      // time_scale
        bs.readBit();                         // fixed_frame_rate_flag
    }

    // hrd_parameters appears up to twice, and low_delay_hrd_flag is present
    // only when at least one of them was.
    auto hrd = [&bs]() {
        const uint32_t cpbCnt = bs.readUE() + 1;
        bs.readBits(4);                       // bit_rate_scale
        bs.readBits(4);                       // cpb_size_scale
        for (uint32_t i = 0; i < cpbCnt && i < 32 && !bs.overrun(); i++) {
            bs.readUE();                      // bit_rate_value_minus1
            bs.readUE();                      // cpb_size_value_minus1
            bs.readBit();                     // cbr_flag
        }
        bs.readBits(5);                       // initial_cpb_removal_delay_length_minus1
        bs.readBits(5);                       // cpb_removal_delay_length_minus1
        bs.readBits(5);                       // dpb_output_delay_length_minus1
        bs.readBits(5);                       // time_offset_length
    };
    const bool nalHrd = bs.readBit() != 0;
    if (nalHrd) hrd();
    const bool vclHrd = bs.readBit() != 0;
    if (vclHrd) hrd();
    if (nalHrd || vclHrd) bs.readBit();       // low_delay_hrd_flag

    bs.readBit();                             // pic_struct_present_flag

    if (bs.readBit()) {                       // bitstream_restriction_flag
        bs.readBit();                         // motion_vectors_over_pic_boundaries
        bs.readUE();                          // max_bytes_per_pic_denom
        bs.readUE();                          // max_bits_per_mb_denom
        bs.readUE();                          // log2_max_mv_length_horizontal
        bs.readUE();                          // log2_max_mv_length_vertical
        const uint32_t reorder = bs.readUE();
        const uint32_t buffering = bs.readUE();
        // A malformed tail must not shrink the reorder window to nothing.
        if (!bs.overrun() && reorder <= 16 && buffering <= 16) {
            sps.bitstream_restriction = true;
            sps.max_num_reorder_frames = (uint8_t)reorder;
            sps.max_dec_frame_buffering = (uint8_t)buffering;
        }
    }
}

// --- SPS -----------------------------------------------------------------

bool H264Parser::parseSPS(const uint8_t* data, size_t size, H264SPS& sps) {
    if (!data || size < 4) return false;

    sps = {};
    H264Bitstream bs(data, size);

    sps.profile_idc = (uint8_t)bs.readBits(8);
    bs.skipBits(8);  // constraint_set flags + reserved_zero_2bits
    sps.level_idc = (uint8_t)bs.readBits(8);
    sps.sps_id = (uint8_t)bs.readUE();
    if (sps.sps_id > 31) return false;

    const bool highProfile =
        sps.profile_idc == 100 || sps.profile_idc == 110 || sps.profile_idc == 122 ||
        sps.profile_idc == 244 || sps.profile_idc == 44  || sps.profile_idc == 83  ||
        sps.profile_idc == 86  || sps.profile_idc == 118 || sps.profile_idc == 128 ||
        sps.profile_idc == 138 || sps.profile_idc == 139 || sps.profile_idc == 134 ||
        sps.profile_idc == 135;

    fillFlat(sps.scaling_list_4x4, sps.scaling_list_8x8);

    if (highProfile) {
        sps.chroma_format_idc = (uint8_t)bs.readUE();
        if (sps.chroma_format_idc > 3) return false;
        if (sps.chroma_format_idc == 3) sps.separate_colour_plane_flag = bs.readBit() != 0;
        sps.bit_depth_luma = (uint8_t)(bs.readUE() + 8);
        sps.bit_depth_chroma = (uint8_t)(bs.readUE() + 8);
        sps.qpprime_y_zero_transform_bypass = bs.readBit() != 0;

        sps.seq_scaling_matrix_present = bs.readBit() != 0;
        if (sps.seq_scaling_matrix_present) {
            int numLists = (sps.chroma_format_idc != 3) ? 8 : 12;
            parseScalingMatrix(bs, numLists, sps.scaling_list_4x4, sps.scaling_list_8x8,
                               nullptr, nullptr);
        }
    }

    sps.log2_max_frame_num = (uint8_t)(bs.readUE() + 4);
    if (sps.log2_max_frame_num > 16) return false;

    sps.pic_order_cnt_type = (uint8_t)bs.readUE();
    if (sps.pic_order_cnt_type == 0) {
        sps.log2_max_pic_order_cnt_lsb = (uint8_t)(bs.readUE() + 4);
        if (sps.log2_max_pic_order_cnt_lsb > 16) return false;
    } else if (sps.pic_order_cnt_type == 1) {
        sps.delta_pic_order_always_zero = bs.readBit() != 0;
        sps.offset_for_non_ref_pic = bs.readSE();
        sps.offset_for_top_to_bottom_field = bs.readSE();
        uint32_t cycle = bs.readUE();
        if (cycle > 255) return false;
        sps.num_ref_frames_in_poc_cycle = (uint8_t)cycle;
        for (uint32_t i = 0; i < cycle; i++) sps.offset_for_ref_frame[i] = bs.readSE();
    } else if (sps.pic_order_cnt_type > 2) {
        return false;
    }

    uint32_t numRef = bs.readUE();
    if (numRef > 16) return false;
    sps.max_num_ref_frames = (uint8_t)numRef;
    sps.gaps_in_frame_num_allowed = bs.readBit() != 0;

    sps.pic_width_in_mbs = bs.readUE() + 1;
    sps.pic_height_in_map_units = bs.readUE() + 1;
    sps.frame_mbs_only = bs.readBit() != 0;
    if (!sps.frame_mbs_only) sps.mb_adaptive_frame_field = bs.readBit() != 0;
    sps.direct_8x8_inference = bs.readBit() != 0;

    sps.frame_cropping = bs.readBit() != 0;
    if (sps.frame_cropping) {
        sps.crop_left   = bs.readUE();
        sps.crop_right  = bs.readUE();
        sps.crop_top    = bs.readUE();
        sps.crop_bottom = bs.readUE();
    }

    // The VUI is where the colour signal and the reorder depth live, so it is
    // parsed rather than skipped. Anything it gets wrong leaves the defaults
    // in place; only a malformed SPS *before* this point is fatal.
    if (bs.overrun()) return false;
    sps.vui_present = bs.readBit() != 0;
    if (sps.vui_present) parseVUI(bs, sps);

    if (sps.pic_width_in_mbs == 0 || sps.pic_height_in_map_units == 0) return false;

    sps.valid = true;
    return true;
}

// --- PPS -----------------------------------------------------------------

bool H264Parser::parsePPS(const uint8_t* data, size_t size, const H264SPS& sps, H264PPS& pps) {
    if (!data || size < 1) return false;

    pps = {};
    H264Bitstream bs(data, size);

    uint32_t ppsId = bs.readUE();
    uint32_t spsId = bs.readUE();
    if (ppsId > 255 || spsId > 31) return false;
    pps.pps_id = (uint8_t)ppsId;
    pps.sps_id = (uint8_t)spsId;

    pps.entropy_coding_mode = bs.readBit() != 0;
    pps.bottom_field_pic_order_in_frame_present = bs.readBit() != 0;

    uint32_t groups = bs.readUE() + 1;
    if (groups > 8) return false;
    pps.num_slice_groups = (uint8_t)groups;
    if (pps.num_slice_groups > 1) {
        uint32_t mapType = bs.readUE();
        if (mapType == 0) {
            for (int i = 0; i < pps.num_slice_groups; i++) bs.readUE();
        } else if (mapType == 2) {
            for (int i = 0; i < pps.num_slice_groups - 1; i++) { bs.readUE(); bs.readUE(); }
        } else if (mapType >= 3 && mapType <= 5) {
            bs.readBit();
            bs.readUE();
        } else if (mapType == 6) {
            uint32_t units = bs.readUE() + 1;
            int bits = 0;
            while ((1u << bits) < groups) bits++;
            if (bits == 0) bits = 1;
            for (uint32_t i = 0; i < units && !bs.overrun(); i++) bs.readBits(bits);
        }
    }

    pps.num_ref_idx_l0_default = (uint8_t)(bs.readUE() + 1);
    pps.num_ref_idx_l1_default = (uint8_t)(bs.readUE() + 1);
    pps.weighted_pred = bs.readBit() != 0;
    pps.weighted_bipred_idc = (uint8_t)bs.readBits(2);
    pps.pic_init_qp = (int8_t)(bs.readSE() + 26);
    pps.pic_init_qs = (int8_t)(bs.readSE() + 26);
    pps.chroma_qp_index_offset = (int8_t)bs.readSE();
    pps.deblocking_filter_control_present = bs.readBit() != 0;
    pps.constrained_intra_pred = bs.readBit() != 0;
    pps.redundant_pic_cnt_present = bs.readBit() != 0;

    // The PPS scaling matrix falls back to the SPS matrix, not to flat.
    memcpy(pps.scaling_list_4x4, sps.scaling_list_4x4, sizeof(pps.scaling_list_4x4));
    memcpy(pps.scaling_list_8x8, sps.scaling_list_8x8, sizeof(pps.scaling_list_8x8));
    pps.second_chroma_qp_index_offset = pps.chroma_qp_index_offset;

    if (bs.moreRbspData()) {
        pps.transform_8x8_mode = bs.readBit() != 0;
        pps.pic_scaling_matrix_present = bs.readBit() != 0;
        if (pps.pic_scaling_matrix_present) {
            int numLists = 6 + (pps.transform_8x8_mode
                ? ((sps.chroma_format_idc != 3) ? 2 : 6) : 0);
            parseScalingMatrix(bs, numLists, pps.scaling_list_4x4, pps.scaling_list_8x8,
                               sps.seq_scaling_matrix_present ? sps.scaling_list_4x4 : nullptr,
                               sps.seq_scaling_matrix_present ? sps.scaling_list_8x8 : nullptr);
        }
        pps.second_chroma_qp_index_offset = (int8_t)bs.readSE();
    }

    if (bs.overrun()) return false;
    pps.valid = true;
    return true;
}

// --- Slice header --------------------------------------------------------

// 7.3.3.1. Nothing here is needed by the hardware; it is parsed only because
// dec_ref_pic_marking sits behind it and none of it is fixed length.
static void skipRefPicListModification(H264Bitstream& bs, const H264SliceHeader& slice) {
    auto skipList = [&bs]() {
        if (!bs.readBit()) return;                 // ref_pic_list_modification_flag
        for (int guard = 0; guard < 64 && !bs.overrun(); guard++) {
            uint32_t op = bs.readUE();
            if (op == 3) break;                    // end of list
            if (op > 3) break;                     // malformed; stop rather than spin
            bs.readUE();                           // abs_diff_pic_num_minus1 / long_term_pic_num
        }
    };
    uint8_t type = slice.sliceTypeNormalized();
    if (type != SLICE_I && type != SLICE_SI) skipList();
    if (type == SLICE_B) skipList();
}

// 7.3.3.2
static void skipPredWeightTable(H264Bitstream& bs, const H264SPS& sps,
                                const H264SliceHeader& slice) {
    bs.readUE();                                   // luma_log2_weight_denom
    int chromaArrayType = sps.separate_colour_plane_flag ? 0 : sps.chroma_format_idc;
    if (chromaArrayType != 0) bs.readUE();         // chroma_log2_weight_denom

    auto skipEntries = [&](int count) {
        for (int i = 0; i < count && !bs.overrun(); i++) {
            if (bs.readBit()) { bs.readSE(); bs.readSE(); }          // luma weight + offset
            if (chromaArrayType != 0 && bs.readBit()) {
                for (int j = 0; j < 2; j++) { bs.readSE(); bs.readSE(); }
            }
        }
    };
    skipEntries(slice.num_ref_idx_l0_active);
    if (slice.sliceTypeNormalized() == SLICE_B) skipEntries(slice.num_ref_idx_l1_active);
}

// 7.3.3.3
static void parseDecRefPicMarking(H264Bitstream& bs, H264SliceHeader& slice) {
    if (slice.idr) {
        slice.no_output_of_prior_pics = bs.readBit() != 0;
        slice.long_term_reference_flag = bs.readBit() != 0;
        return;
    }
    slice.adaptive_ref_pic_marking = bs.readBit() != 0;
    if (!slice.adaptive_ref_pic_marking) return;

    for (int guard = 0; guard < 64 && !bs.overrun(); guard++) {
        H264MMCO m;
        m.op = (uint8_t)bs.readUE();
        if (m.op == 0) break;
        if (m.op > 6) break;                       // malformed
        switch (m.op) {
        case 1: m.difference_of_pic_nums_minus1 = bs.readUE(); break;
        case 2: m.long_term_pic_num = bs.readUE(); break;
        case 3:
            m.difference_of_pic_nums_minus1 = bs.readUE();
            m.long_term_frame_idx = bs.readUE();
            break;
        case 4: m.max_long_term_frame_idx_plus1 = bs.readUE(); break;
        case 5: break;
        case 6: m.long_term_frame_idx = bs.readUE(); break;
        default: break;
        }
        slice.mmco.push_back(m);
    }
}

bool H264Parser::parseSliceHeader(const H264NalUnit& nal,
                                  const H264SPS& sps, const H264PPS& pps,
                                  H264SliceHeader& slice) {
    if (!nal.data || nal.size < 1 || !sps.valid || !pps.valid) return false;

    slice = {};
    slice.idr = (nal.type == NAL_IDR_SLICE);
    slice.nal_ref_idc = nal.nal_ref_idc;

    H264Bitstream bs(nal.data, nal.size);

    slice.first_mb_in_slice = bs.readUE();
    uint32_t sliceType = bs.readUE();
    if (sliceType > 9) return false;
    slice.slice_type = (uint8_t)sliceType;
    slice.pps_id = (uint8_t)bs.readUE();

    if (sps.separate_colour_plane_flag) slice.colour_plane_id = (uint8_t)bs.readBits(2);

    slice.frame_num = (uint16_t)bs.readBits(sps.log2_max_frame_num);

    if (!sps.frame_mbs_only) {
        slice.field_pic_flag = bs.readBit() != 0;
        if (slice.field_pic_flag) slice.bottom_field_flag = bs.readBit() != 0;
    }

    if (slice.idr) slice.idr_pic_id = (uint16_t)bs.readUE();

    if (sps.pic_order_cnt_type == 0) {
        slice.pic_order_cnt_lsb = bs.readBits(sps.log2_max_pic_order_cnt_lsb);
        if (pps.bottom_field_pic_order_in_frame_present && !slice.field_pic_flag)
            slice.delta_pic_order_cnt_bottom = bs.readSE();
    } else if (sps.pic_order_cnt_type == 1 && !sps.delta_pic_order_always_zero) {
        slice.delta_pic_order_cnt[0] = bs.readSE();
        if (pps.bottom_field_pic_order_in_frame_present && !slice.field_pic_flag)
            slice.delta_pic_order_cnt[1] = bs.readSE();
    }

    if (pps.redundant_pic_cnt_present) bs.readUE();   // redundant_pic_cnt

    uint8_t type = slice.sliceTypeNormalized();
    if (type == SLICE_B) bs.readBit();               // direct_spatial_mv_pred_flag

    if (type == SLICE_P || type == SLICE_SP || type == SLICE_B) {
        bool activeOverride = bs.readBit() != 0;
        if (activeOverride) {
            slice.num_ref_idx_l0_active = (uint8_t)(bs.readUE() + 1);
            if (type == SLICE_B) slice.num_ref_idx_l1_active = (uint8_t)(bs.readUE() + 1);
        } else {
            slice.num_ref_idx_l0_active = pps.num_ref_idx_l0_default;
            slice.num_ref_idx_l1_active = (type == SLICE_B) ? pps.num_ref_idx_l1_default : 0;
        }
        if (slice.num_ref_idx_l0_active > 32 || slice.num_ref_idx_l1_active > 32) return false;
    }

    skipRefPicListModification(bs, slice);

    const bool weighted =
        (pps.weighted_pred && (type == SLICE_P || type == SLICE_SP)) ||
        (pps.weighted_bipred_idc == 1 && type == SLICE_B);
    if (weighted) skipPredWeightTable(bs, sps, slice);

    if (slice.nal_ref_idc != 0) parseDecRefPicMarking(bs, slice);

    // Past this point come cabac_init_idc, slice_qp_delta and the deblocking
    // filter controls, none of which the host needs.
    return !bs.overrun();
}
