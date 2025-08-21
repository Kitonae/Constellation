fn main() {
    // Ensure we have a protoc binary available cross-platform without requiring a user install.
    let protoc_path = protoc_bin_vendored::protoc_bin_path().expect("failed to fetch vendored protoc");
    std::env::set_var("PROTOC", &protoc_path);

    let protos = &[
        "../proto/constellation/v1/scene.proto",
        "../proto/constellation/v1/control.proto",
    ];

    tonic_build::configure()
        .type_attribute(".", "#[derive(serde::Serialize, serde::Deserialize)]")
        .compile(protos, &[".."])
        .expect("failed to compile protos");
}
