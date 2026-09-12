#pragma once
// Constant blocks the quad shaders read. Shared between the platforms so the
// scene-to-quad mapping is written once; the HLSL and MSL declarations mirror
// these layouts field for field.

struct TransformCB {
    float position[2];   // world-space offset from center (pixels)
    float scale[2];      // pixel width/height of the quad
    float screenSize[2]; // viewport dimensions
    float _pad[2];
};

// YUV -> RGB conversion parameters for the NV12 shader. Read from the
// stream's nominal range and matrix instead of assuming BT.709 limited range.
struct ColorSpaceCB {
    float yOffset = 16.0f / 255.0f;
    float yScale = 255.0f / 219.0f;
    float cOffset = 128.0f / 255.0f;
    float cScale = 255.0f / 224.0f;
    float kr = 0.2126f;
    float kb = 0.0722f;
    // Visible size over allocated size. The D3D12 decode path writes into a
    // macroblock-aligned surface, so the shader has to stop short of the
    // padding rows; every other path hands back an exact fit and leaves these
    // at one.
    float uvScaleX = 1.0f;
    float uvScaleY = 1.0f;
    // Last texel centre inside the picture. Scaling alone puts the far edge
    // exactly on the boundary with the padding, which a linear sampler then
    // blends into the visible edge whenever the clip is upscaled.
    float uvMaxX = 1.0f;
    float uvMaxY = 1.0f;
    float _pad[2] = {};
};

struct EffectsCB {
    float opacity;
    float blur_radius;
    float brightness;
    float contrast;
    float saturate_amount;
    float grayscale;
    float sepia;
    float hue_rotate_deg;
    float invert;
    // How to read the sampled texel. 0: it is colour. 1: it is Hap Q, scaled
    // YCoCg packed into a DXT5 block, and has to be converted before any
    // effect sees it.
    float colorMode;
    float _pad[2];
};

// Colour conversion parameters as a decoder reports them, before the crop
// terms above are added per frame.
struct ColorSpaceParams {
    float yOffset = 16.0f / 255.0f;
    float yScale = 255.0f / 219.0f;
    float cOffset = 128.0f / 255.0f;
    float cScale = 255.0f / 224.0f;
    float kr = 0.2126f;   // BT.709
    float kb = 0.0722f;
};
