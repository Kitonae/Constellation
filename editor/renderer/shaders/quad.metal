// The renderer's shaders, ported field for field from quad_vs.hlsl,
// effects_ps.hlsl and nv12_effects_ps.hlsl. The constant blocks mirror
// render_constants.h.

#include <metal_stdlib>
using namespace metal;

struct TransformCB {
    float2 position;    // world-space offset from center (pixels)
    float2 scale;       // pixel width/height of the quad
    float2 screenSize;  // viewport dimensions
    float2 _pad;
};

struct EffectsCB {
    float opacity;          // pre-multiplied with fade
    float blur_radius;      // NOT IMPLEMENTED: a real Gaussian needs a
                            // separable two-pass offscreen target; the
                            // web preview applies CSS blur, this does not.
    float brightness;       // multiply RGB (1 = normal)
    float contrast;         // (c - 0.5) * contrast + 0.5
    float saturate_amount;  // lerp(luminance, color, amount) (1 = normal)
    float grayscale;        // lerp(color, luminance, amount) (0 = off)
    float sepia;            // apply sepia matrix, lerp by amount
    float hue_rotate_deg;   // rotate hue in degrees
    float invert;           // lerp(color, 1-color, amount)
    float colorMode;        // 0 = colour, 1 = Hap Q scaled YCoCg (see below)
    float2 _pad;
};

// Conversion parameters supplied by the decoder from the stream's nominal
// range and matrix. Hard-coding BT.709 limited range made SD (BT.601) and
// full-range content come out wrong.
struct ColorSpaceCB {
    float yOffset;   // black level, normalised
    float yScale;    // 255/219 for limited range, 1 for full
    float cOffset;   // 128/255
    float cScale;    // 255/224 for limited range, 1 for full
    float kr;        // luma coefficients (BT.601 / 709 / 2020)
    float kb;
    float2 uvScale;  // cropped size / allocated size (1,1 unless padded)
    float2 uvMax;    // last texel centre inside the picture
    float2 _cs_pad;
};

struct VSOut {
    float4 position [[position]];
    float2 uv;
};

// Linear, clamp: the static sampler s0 of the D3D12 root signature.
constexpr sampler quadSampler(filter::linear, mip_filter::none,
                              address::clamp_to_edge, coord::normalized);

// Positioned quad, generated from the vertex id (0=TL, 1=TR, 2=BL, 3=BR as a
// triangle strip). Metal's clip space is y-up and its texture origin is the
// top-left corner, the same as D3D, so the arithmetic is unchanged.
vertex VSOut quadVS(uint vertexId [[vertex_id]], constant TransformCB& t [[buffer(0)]]) {
    float2 uv = float2(vertexId & 1, vertexId >> 1);

    // Quad in pixel space, centered at origin
    float2 pixelPos = (uv - 0.5) * t.scale;

    // Apply position offset (Y is inverted: positive Y = up in world, down in screen)
    pixelPos.x += t.position.x;
    pixelPos.y -= t.position.y;

    // Offset to screen center
    pixelPos += t.screenSize * 0.5;

    // Convert to clip space: [0, screenSize] -> [-1, 1]
    float2 clipPos;
    clipPos.x = (pixelPos.x / t.screenSize.x) * 2.0 - 1.0;
    clipPos.y = 1.0 - (pixelPos.y / t.screenSize.y) * 2.0;

    VSOut out;
    out.position = float4(clipPos, 0.0, 1.0);
    out.uv = uv;
    return out;
}

static inline float luminance(float3 c) {
    return dot(c, float3(0.2126, 0.7152, 0.0722));
}

// Hue rotation matching the CSS filter. Written as row dot products so the
// coefficient order is exactly the HLSL row-major float3x3.
static inline float3 hueRotate(float3 color, float degrees) {
    float angle = degrees * (M_PI_F / 180.0);
    float s = sin(angle);
    float c_a = cos(angle);
    float3 r0 = float3(0.213 + 0.787 * c_a - 0.213 * s,  0.715 - 0.715 * c_a - 0.715 * s,  0.072 - 0.072 * c_a + 0.928 * s);
    float3 r1 = float3(0.213 - 0.213 * c_a + 0.143 * s,  0.715 + 0.285 * c_a + 0.140 * s,  0.072 - 0.072 * c_a - 0.283 * s);
    float3 r2 = float3(0.213 - 0.213 * c_a - 0.787 * s,  0.715 - 0.715 * c_a + 0.715 * s,  0.072 + 0.928 * c_a + 0.072 * s);
    return float3(dot(r0, color), dot(r1, color), dot(r2, color));
}

// Effects in CSS filter order, identical for both pixel shaders.
static inline float4 applyEffects(float4 color, constant EffectsCB& e) {
    if (e.brightness != 1.0) {
        color.rgb *= e.brightness;
    }
    if (e.contrast != 1.0) {
        color.rgb = (color.rgb - 0.5) * e.contrast + 0.5;
    }
    if (e.saturate_amount != 1.0) {
        float lum = luminance(color.rgb);
        color.rgb = mix(float3(lum), color.rgb, e.saturate_amount);
    }
    if (e.grayscale > 0.0) {
        float lum = luminance(color.rgb);
        color.rgb = mix(color.rgb, float3(lum), e.grayscale);
    }
    if (e.sepia > 0.0) {
        float3 sepiaColor;
        sepiaColor.r = dot(color.rgb, float3(0.393, 0.769, 0.189));
        sepiaColor.g = dot(color.rgb, float3(0.349, 0.686, 0.168));
        sepiaColor.b = dot(color.rgb, float3(0.272, 0.534, 0.131));
        color.rgb = mix(color.rgb, sepiaColor, e.sepia);
    }
    if (e.hue_rotate_deg != 0.0) {
        color.rgb = hueRotate(color.rgb, e.hue_rotate_deg);
    }
    if (e.invert > 0.0) {
        color.rgb = mix(color.rgb, 1.0 - color.rgb, e.invert);
    }
    color.a *= e.opacity;
    return color;
}

fragment float4 effectsPS(VSOut in [[stage_in]],
                          constant EffectsCB& e [[buffer(1)]],
                          texture2d<float> tex [[texture(0)]]) {
    float4 color = tex.sample(quadSampler, in.uv);

    // Hap Q packs Co, Cg, a per-block scale and Y into the four DXT5 channels.
    // The channels are unsigned, so chroma is re-centred; the scale is stored
    // as (scale - 1) * 8 / 255 so that a scale of one reads as zero.
    if (e.colorMode == 1.0) {
        float scale = color.b * (255.0 / 8.0) + 1.0;
        float Co = (color.r - (128.0 / 255.0)) / scale;
        float Cg = (color.g - (128.0 / 255.0)) / scale;
        float Y = color.a;
        color = float4(Y + Co - Cg, Y + Cg, Y - Co - Cg, 1.0);
    }

    return applyEffects(color, e);
}

fragment float4 nv12EffectsPS(VSOut in [[stage_in]],
                              constant EffectsCB& e [[buffer(1)]],
                              constant ColorSpaceCB& cs [[buffer(2)]],
                              texture2d<float> texY [[texture(0)]],
                              texture2d<float> texUV [[texture(1)]]) {
    // uvScale trims padding the decoder wrote past the visible picture, and
    // uvMax keeps the far edge a half texel inside it so the bilinear tap
    // cannot reach the first padding row. Both are (1,1) for decoders that
    // hand back an exactly-sized texture.
    float2 suv = min(in.uv * cs.uvScale, cs.uvMax);

    float  y_val  = texY.sample(quadSampler, suv).r;
    float2 uv_val = texUV.sample(quadSampler, suv).rg;  // bilinear upsampling of chroma

    // YCbCr to RGB using the stream's own range and matrix
    float y  = (y_val    - cs.yOffset) * cs.yScale;
    float cb = (uv_val.x - cs.cOffset) * cs.cScale;
    float cr = (uv_val.y - cs.cOffset) * cs.cScale;

    float kg = 1.0 - cs.kr - cs.kb;
    float3 rgb;
    rgb.r = y + 2.0 * (1.0 - cs.kr) * cr;
    rgb.g = y - (2.0 * cs.kb * (1.0 - cs.kb) / kg) * cb - (2.0 * cs.kr * (1.0 - cs.kr) / kg) * cr;
    rgb.b = y + 2.0 * (1.0 - cs.kb) * cb;

    float4 color = float4(saturate(rgb), 1.0);
    return applyEffects(color, e);
}
