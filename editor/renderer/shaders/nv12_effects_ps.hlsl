// NV12 pixel shader: YUV→RGB conversion + all supported effects in one pass.
// Used for zero-copy video decode via D3D11On12 (NV12 textures from DXVA).

cbuffer EffectsCB : register(b1) {
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
    float3 _pad;
};

// Conversion parameters supplied by the decoder from the stream's
// MF_MT_VIDEO_NOMINAL_RANGE and MF_MT_YUV_MATRIX. Hard-coding BT.709 limited
// range made SD (BT.601) and full-range content come out wrong.
cbuffer ColorSpaceCB : register(b2) {
    float yOffset;   // black level, normalised
    float yScale;    // 255/219 for limited range, 1 for full
    float cOffset;   // 128/255
    float cScale;    // 255/224 for limited range, 1 for full
    float kr;        // luma coefficients (BT.601 / 709 / 2020)
    float kb;
    float2 _cs_pad;
};

// NV12 planes: Y is full resolution, UV is half resolution (4:2:0)
Texture2D<float>  texY  : register(t0);  // R8_UNORM, PlaneSlice=0
Texture2D<float2> texUV : register(t1);  // R8G8_UNORM, PlaneSlice=1
SamplerState samp : register(s0);

// Helper: luminance
float luminance(float3 c) {
    return dot(c, float3(0.2126, 0.7152, 0.0722));
}

// Helper: hue rotation (matches CSS filter behavior)
float3 hueRotate(float3 color, float degrees) {
    float angle = radians(degrees);
    float s = sin(angle);
    float c_a = cos(angle);

    float3x3 mat = float3x3(
        0.213 + 0.787 * c_a - 0.213 * s,  0.715 - 0.715 * c_a - 0.715 * s,  0.072 - 0.072 * c_a + 0.928 * s,
        0.213 - 0.213 * c_a + 0.143 * s,  0.715 + 0.285 * c_a + 0.140 * s,  0.072 - 0.072 * c_a - 0.283 * s,
        0.213 - 0.213 * c_a - 0.787 * s,  0.715 - 0.715 * c_a + 0.715 * s,  0.072 + 0.928 * c_a + 0.072 * s
    );

    return mul(mat, color);
}

float4 PSMain(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
    // Sample NV12 planes
    float  y_val  = texY.Sample(samp, uv);
    float2 uv_val = texUV.Sample(samp, uv);  // bilinear upsampling of chroma

    // YCbCr to RGB using the stream's own range and matrix
    float y  = (y_val    - yOffset) * yScale;
    float cb = (uv_val.x - cOffset) * cScale;
    float cr = (uv_val.y - cOffset) * cScale;

    float kg = 1.0 - kr - kb;
    float3 rgb;
    rgb.r = y + 2.0 * (1.0 - kr) * cr;
    rgb.g = y - (2.0 * kb * (1.0 - kb) / kg) * cb - (2.0 * kr * (1.0 - kr) / kg) * cr;
    rgb.b = y + 2.0 * (1.0 - kb) * cb;

    float4 color = float4(saturate(rgb), 1.0);

    // Apply effects in CSS filter order (identical to effects_ps.hlsl)

    // Brightness
    if (brightness != 1.0) {
        color.rgb *= brightness;
    }

    // Contrast
    if (contrast != 1.0) {
        color.rgb = (color.rgb - 0.5) * contrast + 0.5;
    }

    // Saturate
    if (saturate_amount != 1.0) {
        float lum = luminance(color.rgb);
        color.rgb = lerp(float3(lum, lum, lum), color.rgb, saturate_amount);
    }

    // Grayscale
    if (grayscale > 0.0) {
        float lum = luminance(color.rgb);
        color.rgb = lerp(color.rgb, float3(lum, lum, lum), grayscale);
    }

    // Sepia
    if (sepia > 0.0) {
        float3 sepiaColor;
        sepiaColor.r = dot(color.rgb, float3(0.393, 0.769, 0.189));
        sepiaColor.g = dot(color.rgb, float3(0.349, 0.686, 0.168));
        sepiaColor.b = dot(color.rgb, float3(0.272, 0.534, 0.131));
        color.rgb = lerp(color.rgb, sepiaColor, sepia);
    }

    // Hue rotate
    if (hue_rotate_deg != 0.0) {
        color.rgb = hueRotate(color.rgb, hue_rotate_deg);
    }

    // Invert
    if (invert > 0.0) {
        color.rgb = lerp(color.rgb, 1.0 - color.rgb, invert);
    }

    // Opacity
    color.a *= opacity;

    return color;
}
