# Model sources

GLB and glTF files can be placed on the timeline from Sources using **+** or
**Insert at Playhead**. New placements default to ten seconds, including sources
imported by older versions with a zero duration. Existing clip timings are kept.
**Add as Stage Geometry** remains a separate scene-arrangement action.

Timeline model content is a static pose in a transparent 1024 × 1024 frame,
centered and fitted to a front-facing orthographic camera. Clip position, size,
opacity, fades and effects use the existing compositor. Embedded animation,
camera controls and model rotation are not implemented for timeline content.

The browser renders the model through `editor/ui/src/media/modelContent.js`.
The native media loader reads the actual GLB/glTF file through `model_source.cpp`,
renders its geometry with depth testing in `model_render.cpp`, and delivers
straight-alpha RGBA pixels to the DX12 texture cache. The small Sources thumbnail
is not used as the output image. Source rendering happens once on the loader
thread, then normal output frames reuse the cached texture.

Supported materials use base-color textures/factors, vertex colors, UV transforms,
and simple ambient/directional lighting. This is not a full PBR material renderer.
Native loading supports embedded PNG/JPEG images and local glTF buffer/image
dependencies. Skins, morph targets, Draco/Meshopt compression and sparse indices
currently report a load error. OBJ remains available for scene geometry, with no
native timeline rendering support. As with other native media, use file paths;
browser-only blob URLs cannot be read by the native renderer.

## Validation

```powershell
cmake --build build --config Release
ctest --test-dir build -C Release --output-on-failure
```

`renderer-model` covers GLB parsing, scene transforms, external buffers, Unicode
paths, malformed indices, the asynchronous media loader, depth ordering, texture
color, transparency and straight-alpha output. It uses a graphics device with
WARP fallback.

The UI's `tests/model-import.spec.js` exercises import, thumbnail generation,
timeline insertion, visible model pixels in Stage and web output, and seeking
beyond the clip. It generates a small GLB fixture by default. Set
`CONSTELLATION_TEST_MODEL` to a local GLB path to test a real model.
