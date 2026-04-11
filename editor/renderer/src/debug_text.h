#pragma once

#include <string>
#include <vector>
#include <cstdint>

// Simple bitmap font text renderer for debug overlays.
// Rasterizes text into an RGBA pixel buffer using an embedded 8x8 font.
class DebugText {
public:
    // Initialize the overlay buffer at the given resolution.
    void init(uint32_t width, uint32_t height);

    // Clear the overlay to transparent.
    void clear();

    // Draw a string at pixel position (x, y). Color is RGBA 0-255.
    void drawString(int x, int y, const char* text,
                    uint8_t r = 255, uint8_t g = 255, uint8_t b = 255, uint8_t a = 255);

    // Draw formatted text (printf-style).
    void drawFormat(int x, int y, uint8_t r, uint8_t g, uint8_t b, const char* fmt, ...);

    // Draw a filled rectangle.
    void drawRect(int x, int y, int w, int h, uint8_t r, uint8_t g, uint8_t b, uint8_t a = 255);

    // Draw a horizontal line.
    void drawHLine(int x, int y, int w, uint8_t r, uint8_t g, uint8_t b, uint8_t a = 128);

    // Draw a time-series graph from a ring buffer of values.
    // values: array of floats, count: how many entries, head: index of newest entry
    // graphX/Y/W/H: pixel rect for the graph area
    // maxVal: Y-axis maximum (values are clamped to [0, maxVal])
    // color: graph line color
    // label: text label drawn above the graph
    void drawGraph(int graphX, int graphY, int graphW, int graphH,
                   const float* values, int count, int head,
                   float maxVal,
                   uint8_t r, uint8_t g, uint8_t b,
                   const char* label = nullptr);

    const uint8_t* pixels() const { return m_pixels.data(); }
    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }
    bool dirty() const { return m_dirty; }
    void clearDirty() { m_dirty = false; }

    static constexpr int GLYPH_W = 8;
    static constexpr int GLYPH_H = 8;

private:
    void drawChar(int x, int y, char ch, uint8_t r, uint8_t g, uint8_t b, uint8_t a);

    std::vector<uint8_t> m_pixels;
    uint32_t m_width = 0;
    uint32_t m_height = 0;
    bool m_dirty = false;
};
