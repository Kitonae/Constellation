#pragma once
// The Metal pipeline states for textured quads with effects: one for colour
// (and block-compressed) textures, one for NV12's two planes. Constants go
// in as set*Bytes, textures are bound per draw, so there is no root
// signature or descriptor heap to manage.

#include "objc_ref.h"
#include "render_constants.h"

class RenderPipeline {
public:
    bool init(const ObjcRef& device, const ObjcRef& library);

    // Open a render pass on `target`, cleared to black when `clear` is set,
    // otherwise keeping what is there (the overlay is drawn in a second pass
    // after the NDI capture). Returns false if the encoder could not be made.
    bool beginScreen(const ObjcRef& commandBuffer, const ObjcRef& target, int width, int height, bool clear);
    void endScreen();

    // Draw a textured quad with transform and effects (colour texture).
    void drawQuad(const TransformCB& transform, const EffectsCB& effects, const ObjcRef& texture);

    // Draw a video quad from an NV12 frame's Y and UV planes.
    void drawVideoQuad(const TransformCB& transform, const EffectsCB& effects,
                       const ColorSpaceCB& colorSpace, const ObjcRef& yTexture, const ObjcRef& uvTexture);

    bool hasVideoPipeline() const { return (bool)m_videoPso; }

private:
    void bindPipeline(bool video);

    ObjcRef m_pso;        // id<MTLRenderPipelineState>
    ObjcRef m_videoPso;   // id<MTLRenderPipelineState>
    ObjcRef m_encoder;    // id<MTLRenderCommandEncoder>, while a pass is open
    // Which pipeline the encoder currently has bound. Draw order cannot be
    // sorted (alpha blending depends on it), so switch lazily instead and
    // only when the next draw actually needs the other pipeline.
    int m_bound = -1;
    bool m_initialized = false;
};
