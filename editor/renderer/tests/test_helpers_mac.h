#pragma once
// Metal and CoreVideo fixtures for the regression tests, kept in an
// Objective-C++ file so regression.cpp stays plain C++.

#include "objc_ref.h"
#include <cstdint>
#include <vector>

// A shared event on the default device, or empty when there is no GPU.
ObjcRef testMakeSharedEvent();
void testSignalSharedEvent(const ObjcRef& event, uint64_t value);

// A 32BGRA pixel buffer with padded rows, each row filled with y+1 in every
// channel, copied out through copyPixelBufferBGRA.
bool testCopyPaddedPixelBuffer(uint32_t width, uint32_t height, std::vector<uint8_t>& pixels);
// The copy must refuse a buffer of a different size than asked for.
bool testCopyMismatchedPixelBuffer(uint32_t width, uint32_t height);
