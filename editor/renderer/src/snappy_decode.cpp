#include "snappy_decode.h"

#include <cstring>

bool snappyUncompressedLength(const uint8_t* in, size_t inLen,
                              size_t& outLen, size_t& headerBytes) {
    outLen = 0;
    headerBytes = 0;
    if (!in || inLen == 0) return false;

    // Little-endian base-128 varint, at most five bytes for 32 bits.
    uint64_t value = 0;
    for (size_t i = 0; i < 5 && i < inLen; i++) {
        const uint8_t b = in[i];
        value |= (uint64_t)(b & 0x7F) << (7 * i);
        if (!(b & 0x80)) {
            if (value > 0xFFFFFFFFull) return false;
            outLen = (size_t)value;
            headerBytes = i + 1;
            return true;
        }
    }
    return false;
}

bool snappyUncompress(const uint8_t* in, size_t inLen, uint8_t* out, size_t outLen) {
    size_t declared = 0, header = 0;
    if (!snappyUncompressedLength(in, inLen, declared, header)) return false;
    if (declared != outLen) return false;
    if (outLen > 0 && !out) return false;

    size_t ip = header;
    size_t op = 0;

    while (ip < inLen) {
        const uint8_t tag = in[ip++];
        size_t len = 0;

        switch (tag & 3) {
        case 0: {   // literal
            len = (size_t)(tag >> 2) + 1;
            if (len > 60) {
                // 61..64 mean the length is in the next 1..4 bytes.
                const size_t lenBytes = len - 60;
                if (ip + lenBytes > inLen) return false;
                len = 0;
                for (size_t i = 0; i < lenBytes; i++) len |= (size_t)in[ip + i] << (8 * i);
                len += 1;
                ip += lenBytes;
            }
            if (ip + len > inLen || op + len > outLen) return false;
            memcpy(out + op, in + ip, len);
            ip += len;
            op += len;
            continue;
        }
        case 1: {   // copy, 1-byte offset: 4..11 bytes from up to 2047 back
            len = 4 + ((tag >> 2) & 7);
            if (ip + 1 > inLen) return false;
            const size_t offset = ((size_t)(tag >> 5) << 8) | in[ip];
            ip += 1;
            if (offset == 0 || offset > op || op + len > outLen) return false;
            // The source may overlap the destination (a run), so copy a byte
            // at a time; memmove would resolve the overlap the other way.
            const uint8_t* src = out + op - offset;
            for (size_t i = 0; i < len; i++) out[op + i] = src[i];
            op += len;
            continue;
        }
        case 2:     // copy, 2-byte offset
        case 3: {   // copy, 4-byte offset
            len = (size_t)(tag >> 2) + 1;
            const size_t offBytes = ((tag & 3) == 2) ? 2 : 4;
            if (ip + offBytes > inLen) return false;
            size_t offset = 0;
            for (size_t i = 0; i < offBytes; i++) offset |= (size_t)in[ip + i] << (8 * i);
            ip += offBytes;
            if (offset == 0 || offset > op || op + len > outLen) return false;
            const uint8_t* src = out + op - offset;
            for (size_t i = 0; i < len; i++) out[op + i] = src[i];
            op += len;
            continue;
        }
        }
    }

    // A stream that stops short has been truncated; the caller would upload
    // whatever the buffer held before.
    return op == outLen;
}
