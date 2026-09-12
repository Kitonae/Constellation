#pragma once
// One output window on macOS: an NSWindow whose content view is backed by a
// CAMetalLayer sized to exactly the pixels the screen asked for.

#include "objc_ref.h"
#include <string>
#include <vector>

// Where an output window goes on the desktop. Coordinates are physical
// pixels in the editor's desktop space -- Wails' PhysicalBounds: each
// display's points multiplied by its own backing scale factor, with the
// origin at the top-left of the primary display -- so they match what the
// Output panel shows. Without `positioned` the window is centred on the main
// display.
struct ScreenPlacement {
    bool positioned = false;
    int x = 0;
    int y = 0;
    // No frame or title: the content is exactly width x height at (x, y),
    // which is what covering a display edge to edge needs.
    bool borderless = false;
};

// One display as the placement maths sees it: top-left-origin points
// relative to the primary display, and its backing scale.
struct DesktopDisplay {
    double x = 0, y = 0, width = 0, height = 0;   // points, y down from the primary's top
    double scale = 1.0;
};

// The window content rect, in top-left-origin points, that puts a
// `pixelW` x `pixelH` pixel window at the placement. Chooses the display the
// placement lands on (by centre, then by overlap, then the first), and
// returns its scale so the caller can size the drawable. Pure arithmetic, so
// it can be tested without a window system.
struct ContentRect { double x, y, width, height, scale; };
ContentRect placeOnDesktop(const std::vector<DesktopDisplay>& displays, const ScreenPlacement& placement,
                           int pixelW, int pixelH);

class Screen {
public:
    // `vsync` selects displaySyncEnabled: one screen paces the loop at its
    // refresh, the others present as soon as they can.
    Screen(const std::string& screenId, int width, int height, const ScreenPlacement& placement,
           const ObjcRef& device, bool vsync);
    ~Screen();

    bool isValid() const { return (bool)m_window && (bool)m_layer; }
    // Hidden by its close button, or never shown: the process exits once no
    // window is visible, as on Windows.
    bool isVisible() const;
    const std::string& screenId() const { return m_screenId; }
    int width() const { return m_width; }
    int height() const { return m_height; }

    // Take this frame's drawable. False when none is available (an occluded
    // window can time out), in which case the screen is skipped this frame.
    bool acquireDrawable();
    ObjcRef drawableTexture() const;
    // Schedule the drawable to be shown when the command buffer completes,
    // and let it go.
    void present(const ObjcRef& commandBuffer);

private:
    std::string m_screenId;
    int m_width, m_height;
    ObjcRef m_window;    // NSWindow*
    ObjcRef m_view;      // NSView*
    ObjcRef m_layer;     // CAMetalLayer*
    ObjcRef m_delegate;  // NSWindowDelegate that hides on close
    ObjcRef m_drawable;  // id<CAMetalDrawable>, between acquire and present
};
