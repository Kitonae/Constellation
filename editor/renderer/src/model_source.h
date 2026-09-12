#pragma once
#include <cstdint>
#include <string>
#include <vector>

constexpr uint32_t MODEL_CONTENT_SIZE = 1024;

struct ModelVertex {
    float position[3] = {};
    float normal[3] = {};
    float uv[2] = {};
    float color[4] = {1, 1, 1, 1};
};

struct ModelPart {
    std::vector<ModelVertex> vertices;
    std::vector<uint32_t> indices;
    std::vector<uint8_t> texture; // RGBA, sRGB base colour
    uint32_t textureWidth = 1, textureHeight = 1;
    float tint[4] = {1, 1, 1, 1};
    float alphaCutoff = 0.001f;
    int alphaMode = 0; // 0 opaque, 1 mask, 2 blend
    int wrapS = 10497, wrapT = 10497; // glTF repeat defaults
};

struct ModelSource { std::vector<ModelPart> parts; };

bool isModelFile(const std::string& uri);
// Static pose, transformed through the selected glTF scene and normalized
// into a front-facing 1024px presentation frame. COM must be initialized.
bool loadModelSource(const std::string& path, ModelSource& out, std::string& error);
bool renderModelSource(const ModelSource& model, uint32_t size,
                       std::vector<uint8_t>& rgba, std::string& error);
bool renderModelFile(const std::string& path, uint32_t size,
                     std::vector<uint8_t>& rgba, std::string& error);
