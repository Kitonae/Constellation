fn main() {
  // Build Tauri app resources
  tauri_build::build();

  // Ensure protoc available (vendored) so contributors don't need it installed.
  let protoc_path = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc");
  std::env::set_var("PROTOC", &protoc_path);

  // Generate protobuf bindings for gRPC client to Display server
  let protos = &[
    "../../proto/constellation/v1/scene.proto",
    "../../proto/constellation/v1/control.proto",
  ];
  tonic_build::configure()
    .type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]")
    .compile(protos, &["../../"])
    .expect("compile protos");
}
