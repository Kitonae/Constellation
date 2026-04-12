// 3D model pixel shader — directional + ambient lighting

cbuffer ModelMaterialCB : register(b1) {
    float4 baseColor;
    float  opacity;
    float3 lightDir;       // normalized, points toward light
    float3 lightColor;
    float  ambientIntensity;
    float3 _pad;
};

struct PSInput {
    float4 position    : SV_Position;
    float3 worldNormal : TEXCOORD0;
    float3 worldPos    : TEXCOORD1;
    float2 uv          : TEXCOORD2;
};

float4 PSMain(PSInput input) : SV_Target {
    float3 N = normalize(input.worldNormal);

    // Hemisphere lighting: directional + ambient
    float NdotL = max(dot(N, -lightDir), 0.0);
    float3 diffuse = baseColor.rgb * lightColor * NdotL;
    float3 ambient = baseColor.rgb * ambientIntensity;

    float3 color = diffuse + ambient;
    float alpha = baseColor.a * opacity;

    return float4(color * alpha, alpha); // premultiplied alpha
}
