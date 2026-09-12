#pragma once
// Snappy decompression, and nothing else.
//
// HAP wraps its texture blocks in Snappy, so this is on the path of every
// frame. The format is a stream of literals and back-references with a
// varint length up front -- small enough that carrying a library for it
// would cost more than the sixty lines it takes, and stable enough that the
// implementation does not need to track anything upstream.
//
// Every access is bounds-checked against both buffers; a stream that lies
// about its length or references before its own start is rejected rather
// than read past, because these bytes arrive straight from a file.

#include <cstddef>
#include <cstdint>

/**
 * The uncompressed size a Snappy stream declares.
 *
 * @param headerBytes Receives how many bytes the length preamble occupied.
 * @return false if the preamble is malformed or the stream is empty.
 */
bool snappyUncompressedLength(const uint8_t* in, size_t inLen,
                              size_t& outLen, size_t& headerBytes);

/**
 * Decompress into `out`, which must hold exactly the declared length.
 *
 * @return false on any malformed element, including one that would write
 *         past `outLen` or produce fewer bytes than declared.
 */
bool snappyUncompress(const uint8_t* in, size_t inLen, uint8_t* out, size_t outLen);
