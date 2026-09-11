#pragma once
// H.264 RBSP bitstream reader with Exp-Golomb decoding.
//
// Reads bits from a NAL unit payload (after the start code and the NAL header
// byte), transparently skipping emulation prevention bytes (0x000003 → 0x0000).
//
// Every read is bounds-checked. Past the end the reader latches an overrun
// flag and returns zeroes: a truncated or misparsed NAL then fails the
// `overrun()` check at the end of a parse instead of silently producing
// plausible-looking garbage that reaches the GPU as picture parameters.

#include <cstdint>
#include <cstddef>

class H264Bitstream {
public:
    H264Bitstream() = default;
    H264Bitstream(const uint8_t* data, size_t size) { reset(data, size); }

    void reset(const uint8_t* data, size_t size) {
        m_data = data;
        m_size = size;
        m_bytePos = 0;
        m_bitPos = 0;
        m_zeroRun = 0;
        m_overrun = false;
    }

    uint32_t readBit() {
        if (m_bytePos >= m_size) { m_overrun = true; return 0; }
        if (m_bitPos == 0) skipEmulationPreventionByte();
        if (m_bytePos >= m_size) { m_overrun = true; return 0; }

        uint32_t bit = (m_data[m_bytePos] >> (7 - m_bitPos)) & 1;
        if (++m_bitPos == 8) {
            m_zeroRun = (m_data[m_bytePos] == 0) ? m_zeroRun + 1 : 0;
            m_bitPos = 0;
            m_bytePos++;
        }
        return bit;
    }

    // Up to 32 bits, most significant first.
    uint32_t readBits(int n) {
        uint32_t val = 0;
        for (int i = 0; i < n && i < 32; i++) val = (val << 1) | readBit();
        return val;
    }

    /** Unsigned Exp-Golomb, ue(v). */
    uint32_t readUE() {
        int zeros = 0;
        while (zeros < 32 && readBit() == 0) {
            if (m_overrun) return 0;
            zeros++;
        }
        if (zeros == 0) return 0;
        if (zeros >= 32) { m_overrun = true; return 0; }
        return (1u << zeros) - 1 + readBits(zeros);
    }

    /** Signed Exp-Golomb, se(v). */
    int32_t readSE() {
        uint32_t val = readUE();
        if (val == 0) return 0;
        int32_t mag = (int32_t)((val + 1) >> 1);
        return (val & 1) ? mag : -mag;
    }

    void skipBits(int n) { for (int i = 0; i < n; i++) readBit(); }

    /**
     * more_rbsp_data() per the spec: is there any payload left before the
     * rbsp_stop_one_bit and its zero padding?
     *
     * The PPS High-profile extension is optional and has no length field, so
     * whether to parse `transform_8x8_mode_flag` can only be decided by this
     * test. Approximating it with a byte count misreads short PPS NALs.
     */
    bool moreRbspData() const {
        if (m_bytePos >= m_size) return false;

        // Last byte holding payload: trailing bytes may be zero padding.
        size_t last = m_size;
        while (last > m_bytePos && m_data[last - 1] == 0) last--;
        if (last == 0) return false;
        if (m_bytePos < last - 1) return true;
        if (m_bytePos > last - 1) return false;

        // Same byte as the stop bit: payload remains only if a set bit
        // follows the current position beyond the stop bit itself.
        uint8_t b = m_data[last - 1];
        int stopBit = 0;
        while (stopBit < 8 && ((b >> stopBit) & 1) == 0) stopBit++;
        int lastPayloadBit = 7 - stopBit;   // bit index from the MSB
        return m_bitPos < lastPayloadBit;
    }

    /** True once any read ran past the end of the NAL. */
    bool overrun() const { return m_overrun; }

    size_t bytePosition() const { return m_bytePos; }
    int bitPosition() const { return m_bitPos; }
    size_t totalSize() const { return m_size; }

private:
    // 0x00 0x00 0x03 encodes a literal 0x00 0x00; the 0x03 is not payload.
    // Tracked as a run of de-emulated zero bytes rather than by looking back
    // at raw bytes, so a 0x03 that follows a skipped 0x03 is not mistaken
    // for another prevention byte.
    void skipEmulationPreventionByte() {
        if (m_zeroRun >= 2 && m_data[m_bytePos] == 0x03) {
            m_bytePos++;
            m_zeroRun = 0;
        }
    }

    const uint8_t* m_data = nullptr;
    size_t m_size = 0;
    size_t m_bytePos = 0;
    int m_bitPos = 0;
    int m_zeroRun = 0;
    bool m_overrun = false;
};
