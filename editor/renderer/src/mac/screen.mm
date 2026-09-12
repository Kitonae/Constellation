#include "screen.h"

#import <Cocoa/Cocoa.h>
#import <QuartzCore/CAMetalLayer.h>
#import <Metal/Metal.h>
#include <algorithm>
#include <cstdio>

// The close button hides the window instead of destroying it; App notices
// that nothing is visible and exits, the way WM_CLOSE is handled on Windows.
@interface ConstellationWindowDelegate : NSObject <NSWindowDelegate>
@end
@implementation ConstellationWindowDelegate
- (BOOL)windowShouldClose:(NSWindow*)sender {
    [sender orderOut:nil];
    return NO;
}
@end

// Borderless windows refuse key status by default, which would leave the
// F3/F4/V keys dead on a full-screen output.
@interface ConstellationWindow : NSWindow
@end
@implementation ConstellationWindow
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return YES; }
@end

@interface ConstellationMetalView : NSView
@end
@implementation ConstellationMetalView
- (CALayer*)makeBackingLayer { return [CAMetalLayer layer]; }
- (BOOL)wantsUpdateLayer { return YES; }
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)isOpaque { return YES; }
@end

// --- Placement -------------------------------------------------------------

ContentRect placeOnDesktop(const std::vector<DesktopDisplay>& displays, const ScreenPlacement& placement,
                           int pixelW, int pixelH) {
    ContentRect r = { 0, 0, (double)pixelW, (double)pixelH, 1.0 };
    if (displays.empty()) return r;

    const DesktopDisplay* chosen = &displays[0];
    if (placement.positioned) {
        // Physical rects, as the editor computed them: points x that
        // display's own scale, top-left origin at the primary. With mixed
        // scales those rects can overlap, so the display is the one the
        // window covers most of; a window placed exactly at a display's
        // origin (covering it edge to edge) wins outright.
        const double px = placement.x, py = placement.y;
        const DesktopDisplay* byOrigin = nullptr;
        const DesktopDisplay* byOverlap = nullptr;
        double bestOverlap = 0;
        for (const auto& d : displays) {
            const double dx = d.x * d.scale, dy = d.y * d.scale;
            const double dw = d.width * d.scale, dh = d.height * d.scale;
            if (!byOrigin && px == dx && py == dy) byOrigin = &d;
            const double ox = std::max(0.0, std::min(px + pixelW, dx + dw) - std::max(px, dx));
            const double oy = std::max(0.0, std::min(py + pixelH, dy + dh) - std::max(py, dy));
            if (ox * oy > bestOverlap) { bestOverlap = ox * oy; byOverlap = &d; }
        }
        chosen = byOrigin ? byOrigin : (byOverlap ? byOverlap : chosen);
        r.scale = chosen->scale;
        r.x = px / r.scale;
        r.y = py / r.scale;
    } else {
        r.scale = chosen->scale;
        r.x = chosen->x + (chosen->width - pixelW / r.scale) / 2.0;
        r.y = chosen->y + (chosen->height - pixelH / r.scale) / 2.0;
    }
    r.width = pixelW / r.scale;
    r.height = pixelH / r.scale;
    return r;
}

namespace {

// [NSScreen screens] in the placement's coordinate system. screens[0] is the
// display with the menu bar and the origin of Cocoa's y-up global space.
std::vector<DesktopDisplay> desktopDisplays(double& primaryHeight) {
    std::vector<DesktopDisplay> out;
    NSArray<NSScreen*>* screens = [NSScreen screens];
    if (screens.count == 0) { primaryHeight = 0; return out; }
    primaryHeight = screens[0].frame.size.height;
    for (NSScreen* s in screens) {
        NSRect f = s.frame;
        DesktopDisplay d;
        d.x = f.origin.x;
        d.y = primaryHeight - (f.origin.y + f.size.height);
        d.width = f.size.width;
        d.height = f.size.height;
        d.scale = s.backingScaleFactor;
        out.push_back(d);
    }
    return out;
}

} // namespace

// --- Screen -----------------------------------------------------------------

Screen::Screen(const std::string& screenId, int width, int height, const ScreenPlacement& placement,
               const ObjcRef& device, bool vsync)
    : m_screenId(screenId), m_width(width), m_height(height)
{
    @autoreleasepool {
        double primaryHeight = 0;
        std::vector<DesktopDisplay> displays = desktopDisplays(primaryHeight);
        ContentRect cr = placeOnDesktop(displays, placement, width, height);

        // Top-left-origin points back to Cocoa's bottom-left-origin space.
        NSRect content = NSMakeRect(cr.x, primaryHeight - cr.y - cr.height, cr.width, cr.height);

        NSWindowStyleMask style = placement.borderless
            ? NSWindowStyleMaskBorderless
            : (NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable);

        ConstellationWindow* window = [[ConstellationWindow alloc]
            initWithContentRect:content styleMask:style backing:NSBackingStoreBuffered defer:NO];
        if (!window) {
            fprintf(stderr, "[Screen] Failed to create window for %s\n", screenId.c_str());
            return;
        }
        window.title = [NSString stringWithFormat:@"Renderer: %s", screenId.c_str()];
        window.backgroundColor = [NSColor blackColor];
        window.releasedWhenClosed = NO;
        window.collectionBehavior = NSWindowCollectionBehaviorFullScreenNone |
                                    NSWindowCollectionBehaviorManaged;
        // The drawable never resizes, so neither does the window.
        window.styleMask = window.styleMask & ~NSWindowStyleMaskResizable;

        ConstellationWindowDelegate* delegate = [ConstellationWindowDelegate new];
        window.delegate = delegate;

        ConstellationMetalView* view = [[ConstellationMetalView alloc]
            initWithFrame:NSMakeRect(0, 0, cr.width, cr.height)];
        view.wantsLayer = YES;
        view.layerContentsRedrawPolicy = NSViewLayerContentsRedrawNever;
        CAMetalLayer* layer = (CAMetalLayer*)view.layer;
        layer.device = objc<id<MTLDevice>>(device);
        layer.pixelFormat = MTLPixelFormatBGRA8Unorm;
        // The NDI capture blits from the drawable, which framebufferOnly
        // would forbid.
        layer.framebufferOnly = NO;
        layer.displaySyncEnabled = vsync;
        layer.contentsScale = cr.scale;
        // Exactly the pixels asked for, whatever the display's scale: a
        // 1920x1080 screen is 1920x1080 device pixels on a Retina display.
        layer.drawableSize = CGSizeMake(width, height);
        layer.opaque = YES;
        layer.backgroundColor = CGColorGetConstantColor(kCGColorBlack);

        window.contentView = view;
        [window makeFirstResponder:view];
        // orderFront rather than makeKeyAndOrderFront: the editor keeps focus.
        [window orderFront:nil];

        m_window = retainObjc(window);
        m_view = retainObjc(view);
        m_layer = retainObjc(layer);
        m_delegate = retainObjc(delegate);

        printf("[Screen] Created %s (%dx%d px at %.0f,%.0f pt, scale %.1f%s%s)\n", screenId.c_str(),
            width, height, cr.x, cr.y, cr.scale,
            placement.positioned ? ", positioned" : "", placement.borderless ? ", borderless" : "");
    }
}

Screen::~Screen() {
    @autoreleasepool {
        m_drawable.reset();
        if (m_window) {
            NSWindow* window = objc<NSWindow*>(m_window);
            window.delegate = nil;
            [window orderOut:nil];
            [window close];
        }
        m_layer.reset();
        m_view.reset();
        m_delegate.reset();
        m_window.reset();
    }
}

bool Screen::isVisible() const {
    if (!m_window) return false;
    return objc<NSWindow*>(m_window).isVisible;
}

bool Screen::acquireDrawable() {
    if (!m_layer) return false;
    m_drawable.reset();
    id<CAMetalDrawable> drawable = [objc<CAMetalLayer*>(m_layer) nextDrawable];
    if (!drawable) return false;
    m_drawable = retainObjc(drawable);
    return true;
}

ObjcRef Screen::drawableTexture() const {
    if (!m_drawable) return {};
    return retainObjc(objc<id<CAMetalDrawable>>(m_drawable).texture);
}

void Screen::present(const ObjcRef& commandBuffer) {
    if (!m_drawable) return;
    [objc<id<MTLCommandBuffer>>(commandBuffer) presentDrawable:objc<id<CAMetalDrawable>>(m_drawable)];
    m_drawable.reset();
}
