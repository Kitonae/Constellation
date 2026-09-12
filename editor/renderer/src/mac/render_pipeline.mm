#include "render_pipeline.h"

#import <Metal/Metal.h>
#include <cstdio>

bool RenderPipeline::init(const ObjcRef& deviceRef, const ObjcRef& libraryRef) {
    @autoreleasepool {
        id<MTLDevice> device = objc<id<MTLDevice>>(deviceRef);
        id<MTLLibrary> library = objc<id<MTLLibrary>>(libraryRef);
        if (!device || !library) return false;

        id<MTLFunction> vs = [library newFunctionWithName:@"quadVS"];
        id<MTLFunction> ps = [library newFunctionWithName:@"effectsPS"];
        id<MTLFunction> nv12 = [library newFunctionWithName:@"nv12EffectsPS"];
        if (!vs || !ps) {
            fprintf(stderr, "[Pipeline] shader functions missing from the library\n");
            return false;
        }

        MTLRenderPipelineDescriptor* desc = [MTLRenderPipelineDescriptor new];
        desc.label = @"quad";
        desc.vertexFunction = vs;
        desc.fragmentFunction = ps;
        MTLRenderPipelineColorAttachmentDescriptor* ca = desc.colorAttachments[0];
        ca.pixelFormat = MTLPixelFormatBGRA8Unorm;
        // Alpha blending, straight alpha: SrcAlpha / InvSrcAlpha, alpha One / InvSrcAlpha.
        ca.blendingEnabled = YES;
        ca.rgbBlendOperation = MTLBlendOperationAdd;
        ca.sourceRGBBlendFactor = MTLBlendFactorSourceAlpha;
        ca.destinationRGBBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        ca.alphaBlendOperation = MTLBlendOperationAdd;
        ca.sourceAlphaBlendFactor = MTLBlendFactorOne;
        ca.destinationAlphaBlendFactor = MTLBlendFactorOneMinusSourceAlpha;
        ca.writeMask = MTLColorWriteMaskAll;

        NSError* error = nil;
        id<MTLRenderPipelineState> pso = [device newRenderPipelineStateWithDescriptor:desc error:&error];
        if (!pso) {
            fprintf(stderr, "[Pipeline] quad pipeline failed: %s\n",
                error ? error.localizedDescription.UTF8String : "unknown");
            return false;
        }
        m_pso = retainObjc(pso);

        if (nv12) {
            desc.label = @"nv12 quad";
            desc.fragmentFunction = nv12;
            id<MTLRenderPipelineState> vpso = [device newRenderPipelineStateWithDescriptor:desc error:&error];
            if (vpso) {
                m_videoPso = retainObjc(vpso);
                printf("[Pipeline] NV12 video pipeline created\n");
            } else {
                // Non-fatal: the decoder falls back to BGRA frames.
                fprintf(stderr, "[Pipeline] NV12 pipeline failed: %s (BGRA fallback active)\n",
                    error ? error.localizedDescription.UTF8String : "unknown");
            }
        }

        m_initialized = true;
        printf("[Pipeline] Initialized with textured quad pipeline\n");
        return true;
    }
}

bool RenderPipeline::beginScreen(const ObjcRef& commandBuffer, const ObjcRef& target,
                                 int width, int height, bool clear) {
    if (!m_initialized || m_encoder) return false;
    MTLRenderPassDescriptor* pass = [MTLRenderPassDescriptor renderPassDescriptor];
    MTLRenderPassColorAttachmentDescriptor* ca = pass.colorAttachments[0];
    ca.texture = objc<id<MTLTexture>>(target);
    ca.loadAction = clear ? MTLLoadActionClear : MTLLoadActionLoad;
    ca.storeAction = MTLStoreActionStore;
    ca.clearColor = MTLClearColorMake(0.0, 0.0, 0.0, 1.0);

    id<MTLRenderCommandEncoder> enc =
        [objc<id<MTLCommandBuffer>>(commandBuffer) renderCommandEncoderWithDescriptor:pass];
    if (!enc) return false;
    enc.label = clear ? @"screen" : @"overlay";
    MTLViewport vp = { 0.0, 0.0, (double)width, (double)height, 0.0, 1.0 };
    [enc setViewport:vp];
    m_encoder = retainObjc(enc);
    m_bound = -1;
    return true;
}

void RenderPipeline::endScreen() {
    if (!m_encoder) return;
    [objc<id<MTLRenderCommandEncoder>>(m_encoder) endEncoding];
    m_encoder.reset();
    m_bound = -1;
}

void RenderPipeline::bindPipeline(bool video) {
    int want = video ? 1 : 0;
    if (m_bound == want) return;
    m_bound = want;
    id<MTLRenderCommandEncoder> enc = objc<id<MTLRenderCommandEncoder>>(m_encoder);
    [enc setRenderPipelineState:objc<id<MTLRenderPipelineState>>(video ? m_videoPso : m_pso)];
}

void RenderPipeline::drawQuad(const TransformCB& transform, const EffectsCB& effects,
                              const ObjcRef& texture) {
    if (!m_encoder || !texture) return;
    id<MTLRenderCommandEncoder> enc = objc<id<MTLRenderCommandEncoder>>(m_encoder);
    bindPipeline(false);
    [enc setVertexBytes:&transform length:sizeof(TransformCB) atIndex:0];
    [enc setFragmentBytes:&effects length:sizeof(EffectsCB) atIndex:1];
    [enc setFragmentTexture:objc<id<MTLTexture>>(texture) atIndex:0];
    [enc drawPrimitives:MTLPrimitiveTypeTriangleStrip vertexStart:0 vertexCount:4];
}

void RenderPipeline::drawVideoQuad(const TransformCB& transform, const EffectsCB& effects,
                                   const ColorSpaceCB& colorSpace,
                                   const ObjcRef& yTexture, const ObjcRef& uvTexture) {
    if (!m_encoder || !m_videoPso || !yTexture || !uvTexture) return;
    id<MTLRenderCommandEncoder> enc = objc<id<MTLRenderCommandEncoder>>(m_encoder);
    bindPipeline(true);
    [enc setVertexBytes:&transform length:sizeof(TransformCB) atIndex:0];
    [enc setFragmentBytes:&effects length:sizeof(EffectsCB) atIndex:1];
    [enc setFragmentBytes:&colorSpace length:sizeof(ColorSpaceCB) atIndex:2];
    [enc setFragmentTexture:objc<id<MTLTexture>>(yTexture) atIndex:0];
    [enc setFragmentTexture:objc<id<MTLTexture>>(uvTexture) atIndex:1];
    [enc drawPrimitives:MTLPrimitiveTypeTriangleStrip vertexStart:0 vertexCount:4];
}
