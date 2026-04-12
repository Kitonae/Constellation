#define CGLTF_IMPLEMENTATION
#include "cgltf.h"

#define TINYOBJLOADER_IMPLEMENTATION
#include "tiny_obj_loader.h"

#include "model_loader.h"
#include <cstdio>
#include <cmath>
#include <algorithm>
#include <unordered_map>

// --- URI resolution ---

std::string uriToLocalPath(const std::string& uri) {
    // file:///C:/path → C:/path
    if (uri.rfind("file:///", 0) == 0) {
        std::string path = uri.substr(8);
        // URL decode %20 etc. (minimal: just spaces)
        std::string decoded;
        for (size_t i = 0; i < path.size(); i++) {
            if (path[i] == '%' && i + 2 < path.size()) {
                int hi = 0, lo = 0;
                sscanf(path.c_str() + i + 1, "%1x%1x", &hi, &lo);
                decoded += (char)((hi << 4) | lo);
                i += 2;
            } else {
                decoded += path[i];
            }
        }
        return decoded;
    }
    return uri;
}

// --- glTF/glb loading via cgltf ---

static LoadedModel loadGLTF(const std::string& path) {
    LoadedModel result;

    cgltf_options options = {};
    cgltf_data* data = nullptr;

    if (cgltf_parse_file(&options, path.c_str(), &data) != cgltf_result_success) {
        printf("[ModelLoader] Failed to parse glTF: %s\n", path.c_str());
        return result;
    }
    if (cgltf_load_buffers(&options, data, path.c_str()) != cgltf_result_success) {
        printf("[ModelLoader] Failed to load glTF buffers: %s\n", path.c_str());
        cgltf_free(data);
        return result;
    }
    if (cgltf_validate(data) != cgltf_result_success) {
        printf("[ModelLoader] glTF validation failed: %s\n", path.c_str());
        cgltf_free(data);
        return result;
    }

    result.boundsMin[0] = result.boundsMin[1] = result.boundsMin[2] = 1e30f;
    result.boundsMax[0] = result.boundsMax[1] = result.boundsMax[2] = -1e30f;

    // Iterate all meshes and primitives
    for (cgltf_size mi = 0; mi < data->meshes_count; mi++) {
        const cgltf_mesh& mesh = data->meshes[mi];
        for (cgltf_size pi = 0; pi < mesh.primitives_count; pi++) {
            const cgltf_primitive& prim = mesh.primitives[pi];
            if (prim.type != cgltf_primitive_type_triangles) continue;

            // Find accessors
            const cgltf_accessor* posAccessor = nullptr;
            const cgltf_accessor* normAccessor = nullptr;
            const cgltf_accessor* uvAccessor = nullptr;

            for (cgltf_size ai = 0; ai < prim.attributes_count; ai++) {
                if (prim.attributes[ai].type == cgltf_attribute_type_position)
                    posAccessor = prim.attributes[ai].data;
                else if (prim.attributes[ai].type == cgltf_attribute_type_normal)
                    normAccessor = prim.attributes[ai].data;
                else if (prim.attributes[ai].type == cgltf_attribute_type_texcoord)
                    uvAccessor = prim.attributes[ai].data;
            }

            if (!posAccessor) continue;

            uint32_t vertexBase = (uint32_t)result.vertices.size();
            uint32_t indexBase = (uint32_t)result.indices.size();

            // Read vertices
            cgltf_size vertCount = posAccessor->count;
            for (cgltf_size vi = 0; vi < vertCount; vi++) {
                MeshVertex v = {};
                cgltf_accessor_read_float(posAccessor, vi, v.position, 3);
                if (normAccessor) cgltf_accessor_read_float(normAccessor, vi, v.normal, 3);
                if (uvAccessor) cgltf_accessor_read_float(uvAccessor, vi, v.uv, 2);

                // Update bounds
                for (int a = 0; a < 3; a++) {
                    result.boundsMin[a] = (std::min)(result.boundsMin[a], v.position[a]);
                    result.boundsMax[a] = (std::max)(result.boundsMax[a], v.position[a]);
                }
                result.vertices.push_back(v);
            }

            // Read indices
            if (prim.indices) {
                for (cgltf_size ii = 0; ii < prim.indices->count; ii++) {
                    uint32_t idx = (uint32_t)cgltf_accessor_read_index(prim.indices, ii);
                    result.indices.push_back(vertexBase + idx);
                }
            } else {
                // No indices: generate sequential
                for (uint32_t ii = 0; ii < (uint32_t)vertCount; ii++) {
                    result.indices.push_back(vertexBase + ii);
                }
            }

            // Compute flat normals if the file lacks them
            if (!normAccessor) {
                for (uint32_t ii = indexBase; ii + 2 < (uint32_t)result.indices.size(); ii += 3) {
                    auto& v0 = result.vertices[result.indices[ii]];
                    auto& v1 = result.vertices[result.indices[ii + 1]];
                    auto& v2 = result.vertices[result.indices[ii + 2]];
                    float e1[3] = { v1.position[0] - v0.position[0], v1.position[1] - v0.position[1], v1.position[2] - v0.position[2] };
                    float e2[3] = { v2.position[0] - v0.position[0], v2.position[1] - v0.position[1], v2.position[2] - v0.position[2] };
                    float n[3] = {
                        e1[1] * e2[2] - e1[2] * e2[1],
                        e1[2] * e2[0] - e1[0] * e2[2],
                        e1[0] * e2[1] - e1[1] * e2[0],
                    };
                    float len = sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
                    if (len > 1e-8f) { n[0] /= len; n[1] /= len; n[2] /= len; }
                    for (int k = 0; k < 3; k++) {
                        auto& vn = result.vertices[result.indices[ii + k]];
                        vn.normal[0] = n[0]; vn.normal[1] = n[1]; vn.normal[2] = n[2];
                    }
                }
            }

            // Submesh with material base color
            SubMesh sub;
            sub.indexOffset = indexBase;
            sub.indexCount = (uint32_t)result.indices.size() - indexBase;
            sub.baseColor[0] = sub.baseColor[1] = sub.baseColor[2] = 0.8f;
            sub.baseColor[3] = 1.0f;

            if (prim.material && prim.material->has_pbr_metallic_roughness) {
                const float* bc = prim.material->pbr_metallic_roughness.base_color_factor;
                sub.baseColor[0] = bc[0];
                sub.baseColor[1] = bc[1];
                sub.baseColor[2] = bc[2];
                sub.baseColor[3] = bc[3];
            }

            result.submeshes.push_back(sub);
        }
    }

    cgltf_free(data);
    result.valid = !result.vertices.empty() && !result.indices.empty();
    if (result.valid) {
        printf("[ModelLoader] Loaded glTF: %zu verts, %zu indices, %zu submeshes from %s\n",
               result.vertices.size(), result.indices.size(), result.submeshes.size(), path.c_str());
    }
    return result;
}

// --- OBJ loading via tinyobjloader ---

static LoadedModel loadOBJ(const std::string& path) {
    LoadedModel result;

    tinyobj::ObjReaderConfig config;
    config.triangulate = true;
    tinyobj::ObjReader reader;

    if (!reader.ParseFromFile(path, config)) {
        if (!reader.Error().empty())
            printf("[ModelLoader] OBJ error: %s\n", reader.Error().c_str());
        return result;
    }

    const auto& attrib = reader.GetAttrib();
    const auto& shapes = reader.GetShapes();
    const auto& materials = reader.GetMaterials();

    result.boundsMin[0] = result.boundsMin[1] = result.boundsMin[2] = 1e30f;
    result.boundsMax[0] = result.boundsMax[1] = result.boundsMax[2] = -1e30f;

    // OBJ uses separate indices for pos/normal/uv — we must unify them
    struct VertexKey {
        int vi, ni, ti;
        bool operator==(const VertexKey& o) const { return vi == o.vi && ni == o.ni && ti == o.ti; }
    };
    struct KeyHash {
        size_t operator()(const VertexKey& k) const {
            return std::hash<int>()(k.vi) ^ (std::hash<int>()(k.ni) << 11) ^ (std::hash<int>()(k.ti) << 22);
        }
    };

    for (const auto& shape : shapes) {
        std::unordered_map<VertexKey, uint32_t, KeyHash> vertexMap;
        uint32_t indexBase = (uint32_t)result.indices.size();

        for (const auto& idx : shape.mesh.indices) {
            VertexKey key = { idx.vertex_index, idx.normal_index, idx.texcoord_index };
            auto it = vertexMap.find(key);
            if (it != vertexMap.end()) {
                result.indices.push_back(it->second);
            } else {
                MeshVertex v = {};
                if (key.vi >= 0 && key.vi * 3 + 2 < (int)attrib.vertices.size()) {
                    v.position[0] = attrib.vertices[key.vi * 3 + 0];
                    v.position[1] = attrib.vertices[key.vi * 3 + 1];
                    v.position[2] = attrib.vertices[key.vi * 3 + 2];
                }
                if (key.ni >= 0 && key.ni * 3 + 2 < (int)attrib.normals.size()) {
                    v.normal[0] = attrib.normals[key.ni * 3 + 0];
                    v.normal[1] = attrib.normals[key.ni * 3 + 1];
                    v.normal[2] = attrib.normals[key.ni * 3 + 2];
                }
                if (key.ti >= 0 && key.ti * 2 + 1 < (int)attrib.texcoords.size()) {
                    v.uv[0] = attrib.texcoords[key.ti * 2 + 0];
                    v.uv[1] = attrib.texcoords[key.ti * 2 + 1];
                }
                for (int a = 0; a < 3; a++) {
                    result.boundsMin[a] = (std::min)(result.boundsMin[a], v.position[a]);
                    result.boundsMax[a] = (std::max)(result.boundsMax[a], v.position[a]);
                }
                uint32_t newIdx = (uint32_t)result.vertices.size();
                result.vertices.push_back(v);
                result.indices.push_back(newIdx);
                vertexMap[key] = newIdx;
            }
        }

        SubMesh sub;
        sub.indexOffset = indexBase;
        sub.indexCount = (uint32_t)result.indices.size() - indexBase;
        sub.baseColor[0] = sub.baseColor[1] = sub.baseColor[2] = 0.8f;
        sub.baseColor[3] = 1.0f;

        // Use first material's diffuse color if available
        if (!shape.mesh.material_ids.empty() && shape.mesh.material_ids[0] >= 0) {
            int matIdx = shape.mesh.material_ids[0];
            if (matIdx < (int)materials.size()) {
                sub.baseColor[0] = materials[matIdx].diffuse[0];
                sub.baseColor[1] = materials[matIdx].diffuse[1];
                sub.baseColor[2] = materials[matIdx].diffuse[2];
            }
        }

        result.submeshes.push_back(sub);
    }

    // Compute flat normals if OBJ had none
    bool hasNormals = !attrib.normals.empty();
    if (!hasNormals) {
        for (uint32_t ii = 0; ii + 2 < (uint32_t)result.indices.size(); ii += 3) {
            auto& v0 = result.vertices[result.indices[ii]];
            auto& v1 = result.vertices[result.indices[ii + 1]];
            auto& v2 = result.vertices[result.indices[ii + 2]];
            float e1[3] = { v1.position[0] - v0.position[0], v1.position[1] - v0.position[1], v1.position[2] - v0.position[2] };
            float e2[3] = { v2.position[0] - v0.position[0], v2.position[1] - v0.position[1], v2.position[2] - v0.position[2] };
            float n[3] = {
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            };
            float len = sqrtf(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            if (len > 1e-8f) { n[0] /= len; n[1] /= len; n[2] /= len; }
            for (int k = 0; k < 3; k++) {
                auto& vn = result.vertices[result.indices[ii + k]];
                vn.normal[0] = n[0]; vn.normal[1] = n[1]; vn.normal[2] = n[2];
            }
        }
    }

    result.valid = !result.vertices.empty() && !result.indices.empty();
    if (result.valid) {
        printf("[ModelLoader] Loaded OBJ: %zu verts, %zu indices, %zu submeshes from %s\n",
               result.vertices.size(), result.indices.size(), result.submeshes.size(), path.c_str());
    }
    return result;
}

// --- Public API ---

LoadedModel loadModel(const std::string& path) {
    std::string lowerPath = path;
    std::transform(lowerPath.begin(), lowerPath.end(), lowerPath.begin(), ::tolower);

    if (lowerPath.ends_with(".gltf") || lowerPath.ends_with(".glb")) {
        return loadGLTF(path);
    }
    if (lowerPath.ends_with(".obj")) {
        return loadOBJ(path);
    }

    printf("[ModelLoader] Unsupported format: %s\n", path.c_str());
    return LoadedModel{};
}
