#pragma once

#include "mesh_data.h"
#include <string>

// Load a 3D model from disk. Dispatches by file extension.
// Supports .gltf, .glb (via cgltf), and .obj (via tinyobjloader).
LoadedModel loadModel(const std::string& path);

// Resolve a file:/// URI to a local filesystem path.
std::string uriToLocalPath(const std::string& uri);
