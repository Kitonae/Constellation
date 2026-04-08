// Positioned quad vertex shader.
// Generates a quad from SV_VertexID (0-3), no vertex buffer needed.

cbuffer TransformCB : register(b0) {
    float2 position;    // world-space offset from center (pixels)
    float2 scale;       // pixel width/height of the quad
    float2 screenSize;  // viewport dimensions
    float2 _pad;
};

struct VSOutput {
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

VSOutput VSMain(uint vertexId : SV_VertexID) {
    // Generate quad vertices: 0=TL, 1=TR, 2=BL, 3=BR (triangle strip)
    float2 uv = float2((vertexId & 1), (vertexId >> 1));

    // Quad in pixel space, centered at origin
    float2 pixelPos = (uv - 0.5) * scale;

    // Apply position offset (Y is inverted: positive Y = up in world, down in screen)
    pixelPos.x += position.x;
    pixelPos.y -= position.y;

    // Offset to screen center
    pixelPos += screenSize * 0.5;

    // Convert to clip space: [0, screenSize] -> [-1, 1]
    float2 clipPos;
    clipPos.x = (pixelPos.x / screenSize.x) * 2.0 - 1.0;
    clipPos.y = 1.0 - (pixelPos.y / screenSize.y) * 2.0; // flip Y for DX

    VSOutput output;
    output.position = float4(clipPos, 0.0, 1.0);
    output.uv = uv;
    return output;
}
