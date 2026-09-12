#define NOMINMAX
#define CGLTF_IMPLEMENTATION
#include "../third_party/cgltf/cgltf.h"
#include "model_source.h"
#include <DirectXMath.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <limits>
#include <memory>
#include <stdexcept>

using Microsoft::WRL::ComPtr;
using namespace DirectX;

namespace {
void require(bool ok, const char* message) {
    if (!ok) throw std::runtime_error(message);
}

// cgltf's default fopen cannot open a UTF-8 Windows path. This callback is
// also used for a glTF's external buffers, with cgltf handling relative URIs.
cgltf_result readFile(const cgltf_memory_options*, const cgltf_file_options*,
                      const char* path, cgltf_size* size, void** data) {
    std::ifstream in(std::filesystem::u8path(path), std::ios::binary | std::ios::ate);
    if (!in) return cgltf_result_file_not_found;
    const auto length = in.tellg();
    if (length <= 0 || length > 1024ll * 1024 * 1024) return cgltf_result_io_error;
    const auto bytes = static_cast<size_t>(length);
    if (*size && bytes < *size) return cgltf_result_data_too_short;
    auto memory = std::unique_ptr<void, decltype(&free)>(malloc(bytes), free);
    if (!memory) return cgltf_result_out_of_memory;
    in.seekg(0);
    if (!in.read(static_cast<char*>(memory.get()), bytes)) return cgltf_result_io_error;
    *size = bytes;
    *data = memory.release();
    return cgltf_result_success;
}

std::vector<uint8_t> imageBytes(const cgltf_image& image, const std::filesystem::path& directory) {
    if (image.buffer_view) {
        const auto* bytes = cgltf_buffer_view_data(image.buffer_view);
        require(bytes != nullptr, "Missing embedded model texture");
        return {bytes, bytes + image.buffer_view->size};
    }
    require(image.uri != nullptr, "Model texture has no image source");
    std::string uri = image.uri;
    if (uri.starts_with("data:")) {
        const auto separator = uri.find(";base64,");
        require(separator != std::string::npos, "Unsupported model texture data URI");
        const auto encoded = uri.substr(separator + 8);
        require(!encoded.empty() && encoded.size() % 4 == 0, "Invalid model texture base64");
        size_t bytes = encoded.size() / 4 * 3;
        if (encoded.ends_with("=")) bytes--;
        if (encoded.ends_with("==")) bytes--;
        cgltf_options options{};
        void* data = nullptr;
        require(cgltf_load_buffer_base64(&options, bytes, encoded.c_str(), &data) == cgltf_result_success,
                "Cannot decode model texture base64");
        std::unique_ptr<void, decltype(&free)> owner(data, free);
        const auto* begin = static_cast<uint8_t*>(data);
        return {begin, begin + bytes};
    }
    require(uri.find(":") == std::string::npos, "Remote model textures are not supported");
    cgltf_decode_uri(uri.data());
    const auto path = directory / std::filesystem::u8path(uri.c_str());
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    require(!!in, "Missing external model texture");
    const auto length = in.tellg();
    require(length > 0 && length <= 256ll * 1024 * 1024, "Invalid model texture size");
    std::vector<uint8_t> bytes(static_cast<size_t>(length));
    in.seekg(0);
    require(!!in.read(reinterpret_cast<char*>(bytes.data()), bytes.size()), "Cannot read model texture");
    return bytes;
}

void decodeTexture(const cgltf_image& image, const std::filesystem::path& directory, ModelPart& part) {
    const auto bytes = imageBytes(image, directory);
    ComPtr<IWICImagingFactory> factory;
    require(SUCCEEDED(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
            IID_PPV_ARGS(&factory))), "Cannot initialize model image decoder");
    ComPtr<IWICStream> stream;
    require(SUCCEEDED(factory->CreateStream(&stream)), "Cannot create model texture stream");
    require(SUCCEEDED(stream->InitializeFromMemory(const_cast<BYTE*>(bytes.data()), (DWORD)bytes.size())),
            "Cannot open model texture stream");
    ComPtr<IWICBitmapDecoder> decoder;
    require(SUCCEEDED(factory->CreateDecoderFromStream(stream.Get(), nullptr, WICDecodeMetadataCacheOnLoad, &decoder)),
            "Unsupported model texture image format");
    ComPtr<IWICBitmapFrameDecode> frame;
    require(SUCCEEDED(decoder->GetFrame(0, &frame)), "Cannot read model texture frame");
    ComPtr<IWICFormatConverter> converter;
    require(SUCCEEDED(factory->CreateFormatConverter(&converter)), "Cannot create model texture converter");
    require(SUCCEEDED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA,
            WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom)), "Cannot convert model texture");
    UINT width = 0, height = 0;
    require(SUCCEEDED(converter->GetSize(&width, &height)) && width > 0 && height > 0 &&
            width <= 16384 && height <= 16384, "Invalid model texture dimensions");
    part.texture.resize(size_t(width) * height * 4);
    require(SUCCEEDED(converter->CopyPixels(nullptr, width * 4, (UINT)part.texture.size(), part.texture.data())),
            "Cannot decode model texture pixels");
    part.textureWidth = width;
    part.textureHeight = height;
}

const cgltf_accessor* attribute(const cgltf_primitive& primitive, cgltf_attribute_type type, int index = 0) {
    for (size_t i = 0; i < primitive.attributes_count; i++) {
        const auto& attr = primitive.attributes[i];
        if (attr.type == type && attr.index == index) return attr.data;
    }
    return nullptr;
}

std::vector<float> unpack(const cgltf_accessor* accessor, size_t count, size_t components) {
    if (!accessor) return {};
    require(accessor->count == count && cgltf_num_components(accessor->type) == components,
            "Inconsistent model vertex attributes");
    std::vector<float> values(count * components);
    require(cgltf_accessor_unpack_floats(accessor, values.data(), values.size()) == values.size(),
            "Cannot read model vertex attributes");
    for (float value : values) require(std::isfinite(value), "Non-finite model vertex attribute");
    return values;
}
} // namespace

bool isModelFile(const std::string& uri) {
    auto end = uri.find_first_of("?#");
    auto name = uri.substr(0, end);
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return (char)std::tolower(c); });
    return name.ends_with(".glb") || name.ends_with(".gltf");
}

bool loadModelSource(const std::string& path, ModelSource& out, std::string& error) {
    out.parts.clear();
    error.clear();
    try {
        cgltf_options options{};
        options.file.read = readFile;
        cgltf_data* raw = nullptr;
        require(cgltf_parse_file(&options, path.c_str(), &raw) == cgltf_result_success, "Cannot parse glTF/GLB file");
        std::unique_ptr<cgltf_data, decltype(&cgltf_free)> data(raw, cgltf_free);
        require(cgltf_load_buffers(&options, data.get(), path.c_str()) == cgltf_result_success, "Cannot load model buffers");
        require(cgltf_validate(data.get()) == cgltf_result_success, "Invalid model geometry or buffer ranges");
        require(data->skins_count == 0, "Skinned model output is not supported yet");
        for (size_t i = 0; i < data->buffer_views_count; i++)
            require(!data->buffer_views[i].has_meshopt_compression, "Meshopt-compressed model output is not supported yet");
        const auto directory = std::filesystem::u8path(path).parent_path();
        float lo[3] = {FLT_MAX, FLT_MAX, FLT_MAX}, hi[3] = {-FLT_MAX, -FLT_MAX, -FLT_MAX};
        size_t totalVertices = 0;
        std::function<void(const cgltf_node*)> visit = [&](const cgltf_node* node) {
            if (node->mesh) {
                float world[16];
                cgltf_node_transform_world(node, world);
                const XMMATRIX matrix = XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4*>(world));
                const XMMATRIX normalMatrix = XMMatrixTranspose(XMMatrixInverse(nullptr, matrix));
                for (size_t p = 0; p < node->mesh->primitives_count; p++) {
                    const auto& primitive = node->mesh->primitives[p];
                    require(!primitive.has_draco_mesh_compression, "Draco-compressed model output is not supported yet");
                    require(primitive.targets_count == 0, "Morph-target model output is not supported yet");
                    require(primitive.type == cgltf_primitive_type_triangles || primitive.type == cgltf_primitive_type_triangle_strip ||
                            primitive.type == cgltf_primitive_type_triangle_fan, "Model output requires triangle meshes");
                    const auto* pos = attribute(primitive, cgltf_attribute_type_position);
                    require(pos && pos->count > 0 && pos->count <= 10000000, "Invalid model vertex count");
                    totalVertices += pos->count;
                    require(totalVertices <= 10000000, "Model has too many vertices");
                    const auto positions = unpack(pos, pos->count, 3);
                    const auto normals = unpack(attribute(primitive, cgltf_attribute_type_normal), pos->count, 3);
                    const cgltf_texture_view* textureView = nullptr;
                    ModelPart part;
                    if (primitive.material) {
                        const auto& material = *primitive.material;
                        if (material.has_pbr_metallic_roughness) {
                            std::copy_n(material.pbr_metallic_roughness.base_color_factor, 4, part.tint);
                            textureView = &material.pbr_metallic_roughness.base_color_texture;
                        } else if (material.has_pbr_specular_glossiness) {
                            std::copy_n(material.pbr_specular_glossiness.diffuse_factor, 4, part.tint);
                            textureView = &material.pbr_specular_glossiness.diffuse_texture;
                        }
                        if (material.alpha_mode == cgltf_alpha_mode_mask) part.alphaCutoff = material.alpha_cutoff;
                        part.alphaMode = material.alpha_mode == cgltf_alpha_mode_blend ? 2 :
                            material.alpha_mode == cgltf_alpha_mode_mask ? 1 : 0;
                    }
                    const int uvSet = textureView && textureView->has_transform && textureView->transform.has_texcoord
                        ? textureView->transform.texcoord : (textureView ? textureView->texcoord : 0);
                    const auto uvs = unpack(attribute(primitive, cgltf_attribute_type_texcoord, uvSet), pos->count, 2);
                    const auto* colorsAccessor = attribute(primitive, cgltf_attribute_type_color);
                    const auto colorComponents = colorsAccessor ? cgltf_num_components(colorsAccessor->type) : 0;
                    require(!colorsAccessor || colorComponents == 3 || colorComponents == 4, "Invalid model vertex colors");
                    const auto colors = unpack(colorsAccessor, pos->count, colorComponents);
                    part.vertices.resize(pos->count);
                    for (size_t v = 0; v < pos->count; v++) {
                        auto& vertex = part.vertices[v];
                        XMFLOAT3 point;
                        XMStoreFloat3(&point, XMVector3TransformCoord(XMVectorSet(positions[v*3], positions[v*3+1], positions[v*3+2], 1), matrix));
                        std::memcpy(vertex.position, &point, sizeof(point));
                        for (int axis = 0; axis < 3; axis++) {
                            require(std::isfinite(vertex.position[axis]), "Invalid model node transform");
                            lo[axis] = std::min(lo[axis], vertex.position[axis]);
                            hi[axis] = std::max(hi[axis], vertex.position[axis]);
                        }
                        if (!normals.empty()) {
                            XMStoreFloat3(&point, XMVector3Normalize(XMVector3TransformNormal(
                                XMVectorSet(normals[v*3], normals[v*3+1], normals[v*3+2], 0), normalMatrix)));
                            std::memcpy(vertex.normal, &point, sizeof(point));
                        }
                        if (!uvs.empty()) std::copy_n(&uvs[v*2], 2, vertex.uv);
                        if (textureView && textureView->has_transform) {
                            const auto& t = textureView->transform;
                            const float x = vertex.uv[0] * t.scale[0], y = vertex.uv[1] * t.scale[1];
                            vertex.uv[0] = t.offset[0] + cosf(t.rotation)*x - sinf(t.rotation)*y;
                            vertex.uv[1] = t.offset[1] + sinf(t.rotation)*x + cosf(t.rotation)*y;
                        }
                        if (!colors.empty()) std::copy_n(&colors[v*colorComponents], colorComponents, vertex.color);
                    }
                    const size_t indexCount = primitive.indices ? primitive.indices->count : pos->count;
                    require(!primitive.indices || !primitive.indices->is_sparse, "Sparse model indices are not supported");
                    require(indexCount <= 30000000, "Model has too many indices");
                    std::vector<uint32_t> indices(indexCount);
                    for (size_t i = 0; i < indexCount; i++) {
                        const size_t value = primitive.indices ? cgltf_accessor_read_index(primitive.indices, i) : i;
                        require(value < pos->count, "Model index is outside its vertex buffer");
                        indices[i] = (uint32_t)value;
                    }
                    if (primitive.type == cgltf_primitive_type_triangles) {
                        require(indexCount % 3 == 0, "Incomplete model triangle");
                        part.indices = std::move(indices);
                    } else for (size_t i = 2; i < indexCount; i++) {
                        const bool strip = primitive.type == cgltf_primitive_type_triangle_strip;
                        part.indices.insert(part.indices.end(), {strip ? indices[i-2] : indices[0], indices[i-1], indices[i]});
                        if (strip && i % 2) std::swap(part.indices[part.indices.size()-3], part.indices[part.indices.size()-2]);
                    }
                    if (normals.empty()) {
                        for (size_t i = 0; i < part.indices.size(); i += 3) {
                            auto& a = part.vertices[part.indices[i]];
                            auto& b = part.vertices[part.indices[i+1]];
                            auto& c = part.vertices[part.indices[i+2]];
                            const auto pa = XMLoadFloat3(reinterpret_cast<XMFLOAT3*>(a.position));
                            const auto pb = XMLoadFloat3(reinterpret_cast<XMFLOAT3*>(b.position));
                            const auto pc = XMLoadFloat3(reinterpret_cast<XMFLOAT3*>(c.position));
                            XMFLOAT3 normal;
                            XMStoreFloat3(&normal, XMVector3Cross(pb-pa, pc-pa));
                            for (auto* vertex : {&a, &b, &c}) {
                                vertex->normal[0] += normal.x; vertex->normal[1] += normal.y; vertex->normal[2] += normal.z;
                            }
                        }
                    }
                    if (textureView && textureView->texture) {
                        require(textureView->texture->image != nullptr, "Unsupported model texture extension");
                        if (const auto* sampler = textureView->texture->sampler) {
                            part.wrapS = sampler->wrap_s;
                            part.wrapT = sampler->wrap_t;
                        }
                        decodeTexture(*textureView->texture->image, directory, part);
                    } else part.texture = {255, 255, 255, 255};
                    if (!part.indices.empty()) out.parts.push_back(std::move(part));
                }
            }
            for (size_t i = 0; i < node->children_count; i++) visit(node->children[i]);
        };
        const cgltf_scene* scene = data->scene ? data->scene : (data->scenes_count ? &data->scenes[0] : nullptr);
        if (scene) for (size_t i = 0; i < scene->nodes_count; i++) visit(scene->nodes[i]);
        else for (size_t i = 0; i < data->nodes_count; i++) if (!data->nodes[i].parent) visit(&data->nodes[i]);
        require(!out.parts.empty(), "Model has no visible geometry");
        const float extent = std::max({hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]});
        require(extent > 0 && std::isfinite(extent), "Model has invalid bounds");
        for (auto& part : out.parts) for (auto& vertex : part.vertices)
            for (int axis = 0; axis < 3; axis++) vertex.position[axis] = (vertex.position[axis] - (lo[axis]+hi[axis])*0.5f) * (1.8f/extent);
        return true;
    } catch (const std::exception& exception) {
        error = exception.what();
        out.parts.clear();
        return false;
    }
}

bool renderModelFile(const std::string& path, uint32_t size, std::vector<uint8_t>& rgba, std::string& error) {
    ModelSource model;
    return loadModelSource(path, model, error) && renderModelSource(model, size, rgba, error);
}
