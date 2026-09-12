#define NOMINMAX
#include "model_source.h"
#include "media_loader.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <thread>

namespace {
void check(bool ok, const std::string& message) {
    if (!ok) throw std::runtime_error(message);
}

struct Fixture {
    std::filesystem::path directory = std::filesystem::temp_directory_path() /
        (L"constellation-model-\u00e9-" + std::to_wstring(GetCurrentProcessId()));
    Fixture() { std::filesystem::create_directories(directory); }
    ~Fixture() {
        // Only these test-owned files, never a recursive removal of temp paths.
        for (const auto* name : {L"model.glb", L"model.gltf", L"mesh.bin", L"broken.glb"}) {
            std::error_code ec;
            std::filesystem::remove(directory / name, ec);
        }
        std::error_code ec;
        std::filesystem::remove(directory, ec);
    }
    std::string path(const char* name) const {
        const auto utf8 = (directory / name).u8string();
        return {utf8.begin(), utf8.end()};
    }
    void write(const char* name, const void* bytes, size_t size) const {
        std::ofstream file(directory / name, std::ios::binary);
        file.write(static_cast<const char*>(bytes), size);
        check(bool(file), "Cannot write model fixture");
    }
};

std::vector<uint8_t> glb(nlohmann::json json, const std::vector<uint8_t>& bytes) {
    auto text = json.dump();
    while (text.size() % 4) text += ' ';
    std::vector<uint8_t> result;
    auto u32 = [&](uint32_t value) {
        for (int i = 0; i < 4; i++) result.push_back(uint8_t(value >> (i*8)));
    };
    u32(0x46546c67); u32(2); u32(uint32_t(28 + text.size() + bytes.size()));
    u32(uint32_t(text.size())); u32(0x4e4f534a);
    result.insert(result.end(), text.begin(), text.end());
    u32(uint32_t(bytes.size())); u32(0x004e4942);
    result.insert(result.end(), bytes.begin(), bytes.end());
    return result;
}
} // namespace

void testModel() {
    Fixture fixture;
    auto json = nlohmann::json::parse(R"({
      "asset":{"version":"2.0"}, "buffers":[{"byteLength":44}],
      "bufferViews":[{"buffer":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":6}],
      "accessors":[
        {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]},
        {"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}
      ],
      "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1}]}],
      "nodes":[{"translation":[4,-2,3],"scale":[2,1,1],"children":[1]},{"mesh":0}],
      "scenes":[{"nodes":[0]}], "scene":0
    })");
    const float positions[] = {0,0,0, 1,0,0, 0,1,0};
    const uint16_t indices[] = {0,1,2};
    std::vector<uint8_t> bytes(44);
    std::memcpy(bytes.data(), positions, sizeof(positions));
    std::memcpy(bytes.data()+36, indices, sizeof(indices));
    auto binary = glb(json, bytes);
    fixture.write("model.glb", binary.data(), binary.size());
    ModelSource model;
    std::string error;
    check(loadModelSource(fixture.path("model.glb"), model, error), error);
    check(model.parts.size() == 1 && model.parts[0].indices.size() == 3, "GLB geometry was not loaded");
    const auto& v = model.parts[0].vertices[0];
    check(std::abs(v.position[0]+0.9f) < 1e-5f && std::abs(v.position[1]+0.45f) < 1e-5f &&
          std::abs(v.position[2]) < 1e-5f, "Scene hierarchy or normalized framing is wrong");
    check(v.normal[2] > 0.99f, "Missing vertex normals were not generated");

    // The same model with an external buffer must load, too.
    json["buffers"][0]["uri"] = "mesh.bin";
    const auto text = json.dump();
    fixture.write("model.gltf", text.data(), text.size());
    fixture.write("mesh.bin", bytes.data(), bytes.size());
    check(loadModelSource(fixture.path("model.gltf"), model, error), error);

    // Exercise the actual asynchronous request used by App's prefetch path.
    MediaLoader loader;
    loader.start();
    const auto uri = "file:///" + fixture.path("model.glb");
    loader.requestImage(uri);
    std::vector<MediaLoader::Ready> ready;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
    while (ready.empty() && std::chrono::steady_clock::now() < deadline) {
        ready = loader.drainReady();
        if (ready.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    loader.stop();
    check(ready.size() == 1 && !ready[0].failed && ready[0].key == uri, "Model was not delivered to the compositor cache");
    check(ready[0].width == MODEL_CONTENT_SIZE && ready[0].height == MODEL_CONTENT_SIZE &&
          ready[0].rgba.size() == size_t(MODEL_CONTENT_SIZE)*MODEL_CONTENT_SIZE*4,
          "Model source size differs from Stage preview");
    check(ready[0].rgba[3] == 0, "Model background is not transparent");
    check(std::count(ready[0].rgba.begin(), ready[0].rgba.end(), uint8_t(255)) > 10000,
          "Loader returned a blank model frame");

    // Draw a front red triangle before a rear blue one: depth, not submission
    // order, must pick the visible surface. Sample straight alpha as well.
    auto front = model.parts[0];
    for (auto& vertex : front.vertices) vertex.position[2] = 0.5f;
    front.texture = {255, 0, 0, 255};
    auto back = front;
    for (auto& vertex : back.vertices) vertex.position[2] = -0.5f;
    back.texture = {0, 0, 255, 255};
    model.parts = {front, back};
    std::vector<uint8_t> pixels;
    check(renderModelSource(model, 128, pixels, error), error);
    const size_t inside = (70*128+32)*4;
    check(pixels[inside] > 200 && pixels[inside+2] == 0 && pixels[inside+3] == 255,
          "Model depth test or base-color texture is wrong");
    model.parts = {front};
    model.parts[0].tint[3] = 0.5f;
    model.parts[0].alphaMode = 2;
    check(renderModelSource(model, 128, pixels, error), error);
    check(pixels[inside] > 200 && std::abs(int(pixels[inside+3])-128) <= 1,
          "Model source is not straight alpha for the compositor");

    // Invalid indices must produce a failed load, not an out-of-bounds draw.
    json["buffers"][0].erase("uri");
    bytes[36] = 99;
    binary = glb(json, bytes);
    fixture.write("broken.glb", binary.data(), binary.size());
    check(!loadModelSource(fixture.path("broken.glb"), model, error) && !error.empty() && model.parts.empty(),
          "Malformed model was accepted or kept stale geometry");
}
