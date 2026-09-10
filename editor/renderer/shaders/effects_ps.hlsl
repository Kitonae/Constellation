// Pixel shader with all supported effects.

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

Texture2D tex : register(t0);
SamplerState samp : register(s0);

// Helper: luminance
float luminance(float3 c) {
    return dot(c, float3(0.2126, 0.7152, 0.0722));
}

// Helper: RGB to HSL and back (simplified)
float3 hueRotate(float3 color, float degrees) {
    float angle = radians(degrees);
    float s = sin(angle);
    float c_a = cos(angle);

    // Rotation matrix for hue (approximate, matches CSS filter behavior)
    float3x3 mat = float3x3(
        0.213 + 0.787 * c_a - 0.213 * s,  0.715 - 0.715 * c_a - 0.715 * s,  0.072 - 0.072 * c_a + 0.928 * s,
        0.213 - 0.213 * c_a + 0.143 * s,  0.715 + 0.285 * c_a + 0.140 * s,  0.072 - 0.072 * c_a - 0.283 * s,
        0.213 - 0.213 * c_a - 0.787 * s,  0.715 - 0.715 * c_a + 0.715 * s,  0.072 + 0.928 * c_a + 0.072 * s
    );

    return mul(mat, color);
}

float4 PSMain(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_Target {
    float4 color = tex.Sample(samp, uv);

    // Apply effects in CSS filter order

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
