struct Camera {
  view_proj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct VsIn {
  @location(0) pos: vec3<f32>;
  @location(1) uv: vec2<f32>;
  @location(2) m0: vec4<f32>;
  @location(3) m1: vec4<f32>;
  @location(4) m2: vec4<f32>;
  @location(5) m3: vec4<f32>;
};

struct VsOut {
  @builtin(position) pos: vec4<f32>;
  @location(0) v_uv: vec2<f32>;
};

@vertex
fn vs_main(input: VsIn) -> VsOut {
  var out: VsOut;
  let model = mat4x4<f32>(input.m0, input.m1, input.m2, input.m3);
  let world = model * vec4<f32>(input.pos, 1.0);
  out.pos = camera.view_proj * world;
  out.v_uv = input.uv;
  return out;
}

@fragment
fn fs_main(inf: VsOut) -> @location(0) vec4<f32> {
  let uv = vec2<f32>(inf.v_uv.x, 1.0 - inf.v_uv.y);
  let color = textureSample(tex, samp, uv);
  return color;
}
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;
