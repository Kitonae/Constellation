// 3D model vertex shader — MVP transform with world-space outputs for lighting

cbuffer ModelTransformCB : register(b0) {
    float4x4 mvp;       // model-view-projection
    float4x4 model;     // model matrix (for world-space normals)
    float4   cameraPos; // world-space camera position
};

struct VSInput {
    float3 position : POSITION;
    float3 normal   : NORMAL;
    float2 uv       : TEXCOORD0;
};

struct VSOutput {
    float4 position    : SV_Position;
    float3 worldNormal : TEXCOORD0;
    float3 worldPos    : TEXCOORD1;
    float2 uv          : TEXCOORD2;
};

VSOutput VSMain(VSInput input) {
    VSOutput output;
    output.position = mul(mvp, float4(input.position, 1.0));
    output.worldPos = mul(model, float4(input.position, 1.0)).xyz;
    output.worldNormal = normalize(mul((float3x3)model, input.normal));
    output.uv = input.uv;
    return output;
}
