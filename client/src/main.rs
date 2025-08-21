use clap::{Parser, Subcommand};
use tonic::transport::Channel;
use tonic::Request;

pub mod proto {
    tonic::include_proto!("constellation.v1");
}

use proto::display_control_client::DisplayControlClient;
use proto::*;

#[derive(Parser, Debug)]
#[command(name = "constellation", about = "Constellation Display CLI", version)]
struct Cli {
    /// Display server address
    #[arg(short, long, default_value = "http://127.0.0.1:50051")]
    addr: String,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Load a project from JSON file (editor-facing JSON)
    LoadProject { file: String },
    /// Transport controls
    Play { #[arg(long)] at: Option<f64> },
    Pause,
    Stop,
    Seek { to: f64 },
    Rate { rate: f64 },
    /// Subscribe and print state updates
    Subscribe,
}

async fn connect(addr: &str) -> Result<DisplayControlClient<Channel>, Box<dyn std::error::Error>> {
    let client = DisplayControlClient::connect(addr.to_string()).await?;
    Ok(client)
}

// ------------- JSON structures (editor-facing) -------------
#[derive(Debug, serde::Deserialize)]
struct Vec3J { x: f32, y: f32, z: f32 }
#[derive(Debug, serde::Deserialize)]
struct QuatJ { x: f32, y: f32, z: f32, w: f32 }
#[derive(Debug, serde::Deserialize)]
struct TransformJ { position: Vec3J, rotation: QuatJ, scale: Vec3J }
#[derive(Debug, serde::Deserialize)]
struct ColorJ { r: f32, g: f32, b: f32, a: f32 }

#[derive(Debug, serde::Deserialize)]
struct MaterialPbrJ {
    id: String,
    name: Option<String>,
    base_color: Option<ColorJ>,
    metallic: Option<f32>,
    roughness: Option<f32>,
    emissive: Option<ColorJ>,
}
#[derive(Debug, serde::Deserialize)]
struct MeshRefJ { id: String, uri: String, node: Option<String> }

#[derive(Debug, serde::Deserialize)]
struct MeshCompJ { mesh: MeshRefJ, material_id: Option<String> }
#[derive(Debug, serde::Deserialize)]
struct LightCompJ { r#type: String, color: ColorJ, intensity: f32, range: f32, spot_angle: Option<f32> }
#[derive(Debug, serde::Deserialize)]
struct ScreenCompJ { pixels_x: i32, pixels_y: i32 }
#[derive(Debug, serde::Deserialize)]
struct CameraCompJ { fov_deg: f32, near: f32, far: f32 }

#[derive(Debug, serde::Deserialize)]
struct NodeJ {
    id: String,
    name: Option<String>,
    transform: TransformJ,
    #[serde(default)]
    children: Vec<NodeJ>,
    mesh: Option<MeshCompJ>,
    light: Option<LightCompJ>,
    screen: Option<ScreenCompJ>,
    camera: Option<CameraCompJ>,
}

#[derive(Debug, serde::Deserialize)]
struct SceneJ {
    id: String,
    name: Option<String>,
    #[serde(default)]
    materials: Vec<MaterialPbrJ>,
    #[serde(default)]
    meshes: Vec<MeshRefJ>,
    #[serde(default)]
    roots: Vec<NodeJ>,
}

#[derive(Debug, serde::Deserialize)]
struct MediaClipJ { id: String, name: Option<String>, uri: String, duration_seconds: f64 }
#[derive(Debug, serde::Deserialize)]
struct TrackMediaJ { target_node_id: String, clip_id: String, in_seconds: f64, out_seconds: f64, start_at_seconds: f64 }
#[derive(Debug, serde::Deserialize)]
struct TimelineTrackJ { media: Option<TrackMediaJ> }
#[derive(Debug, serde::Deserialize)]
struct TimelineEventJ { t: f64, action: String, #[serde(default)] params: std::collections::HashMap<String, String> }
#[derive(Debug, serde::Deserialize)]
struct TimelineJ { id: String, name: Option<String>, #[serde(default)] tracks: Vec<TimelineTrackJ>, #[serde(default)] events: Vec<TimelineEventJ>, duration_seconds: f64 }
#[derive(Debug, serde::Deserialize)]
struct ProjectJ { id: String, name: Option<String>, scene: SceneJ, #[serde(default)] media: Vec<MediaClipJ>, timeline: TimelineJ }
#[derive(Debug, serde::Deserialize)]
struct ProjectWrapperJ { project: ProjectJ }

fn to_proto_vec3(v: Vec3J) -> Vec3 { Vec3 { x: v.x, y: v.y, z: v.z } }
fn to_proto_quat(q: QuatJ) -> Quat { Quat { x: q.x, y: q.y, z: q.z, w: q.w } }
fn to_proto_transform(t: TransformJ) -> Transform { Transform { position: Some(to_proto_vec3(t.position)), rotation: Some(to_proto_quat(t.rotation)), scale: Some(to_proto_vec3(t.scale)) } }
fn to_proto_color(c: ColorJ) -> ColorRgba { ColorRgba { r: c.r, g: c.g, b: c.b, a: c.a } }

fn to_proto_material(m: MaterialPbrJ) -> MaterialPbr {
    MaterialPbr {
        id: m.id,
        name: m.name.unwrap_or_default(),
        base_color: m.base_color.map(to_proto_color),
        base_color_tex: None,
        metallic: m.metallic.unwrap_or(0.0),
        roughness: m.roughness.unwrap_or(1.0),
        mr_tex: None,
        emissive: m.emissive.map(to_proto_color),
        emissive_tex: None,
    }
}
fn to_proto_meshref(m: MeshRefJ) -> MeshRef { MeshRef { id: m.id, uri: m.uri, node: m.node.unwrap_or_default() } }
fn to_proto_node(n: NodeJ) -> Node {
    let mut node = Node { id: n.id, name: n.name.unwrap_or_default(), transform: Some(to_proto_transform(n.transform)), children: n.children.into_iter().map(to_proto_node).collect(), comp0: None };
    if let Some(s) = n.screen { node.comp0 = Some(node::Comp0::Screen(ScreenComponent { pixels_x: s.pixels_x, pixels_y: s.pixels_y })); }
    if let Some(l) = n.light { 
        let t = match l.r#type.as_str() { "DIRECTIONAL" => 1, "SPOT" => 2, _ => 0 };
        node.comp0 = Some(node::Comp0::Light(LightComponent { r#type: t, color: Some(to_proto_color(l.color)), intensity: l.intensity, range: l.range, spot_angle: l.spot_angle.unwrap_or(0.0) }));
    }
    if let Some(c) = n.camera { node.comp0 = Some(node::Comp0::Camera(CameraComponent { fov_deg: c.fov_deg, near: c.near, far: c.far })); }
    if let Some(m) = n.mesh { node.comp0 = Some(node::Comp0::Mesh(MeshComponent { mesh: Some(to_proto_meshref(m.mesh)), material_id: m.material_id.unwrap_or_default() })); }
    node
}
fn to_proto_scene(s: SceneJ) -> Scene {
    Scene {
        id: s.id,
        name: s.name.unwrap_or_default(),
        materials: s.materials.into_iter().map(to_proto_material).collect(),
        meshes: s.meshes.into_iter().map(to_proto_meshref).collect(),
        roots: s.roots.into_iter().map(to_proto_node).collect(),
    }
}
fn to_proto_project(p: ProjectJ) -> Project {
    let media = p.media.into_iter().map(|m| MediaClip { id: m.id, name: m.name.unwrap_or_default(), uri: m.uri, duration_seconds: m.duration_seconds }).collect();
    let tracks = p.timeline.tracks.into_iter().filter_map(|t| {
        if let Some(m) = t.media { Some(TimelineTrack { kind: Some(timeline_track::Kind::Media(TrackMedia { target_node_id: m.target_node_id, clip_id: m.clip_id, in_seconds: m.in_seconds, out_seconds: m.out_seconds, start_at_seconds: m.start_at_seconds })) }) } else { None }
    }).collect();
    let events = p.timeline.events.into_iter().map(|e| TimelineEvent { t: e.t, action: e.action, params: e.params }).collect();
    Project {
        id: p.id,
        name: p.name.unwrap_or_default(),
        scene: Some(to_proto_scene(p.scene)),
        media,
        timeline: Some(Timeline { id: p.timeline.id, name: p.timeline.name.unwrap_or_default(), tracks, events, duration_seconds: p.timeline.duration_seconds }),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let mut client = connect(&cli.addr).await?;

    match cli.command {
        Commands::LoadProject { file } => {
            let data = std::fs::read_to_string(file)?;
            let wrapper: ProjectWrapperJ = serde_json::from_str(&data)?;
            let project = to_proto_project(wrapper.project);
            let resp = client.load_project(Request::new(LoadProjectRequest { project: Some(project) })).await?;
            println!("{:?}", resp.into_inner());
        }
        Commands::Play { at } => {
            let resp = client.play(Request::new(PlayRequest { at_seconds: at.unwrap_or(0.0) })).await?;
            println!("{:?}", resp.into_inner());
        }
        Commands::Pause => {
            let resp = client.pause(Request::new(PauseRequest {})).await?;
            println!("{:?}", resp.into_inner());
        }
        Commands::Stop => {
            let resp = client.stop(Request::new(StopRequest {})).await?;
            println!("{:?}", resp.into_inner());
        }
        Commands::Seek { to } => {
            let resp = client.seek(Request::new(SeekRequest { to_seconds: to })).await?;
            println!("{:?}", resp.into_inner());
        }
        Commands::Rate { rate } => {
            let resp = client.set_rate(Request::new(SetRateRequest { rate })).await?;
            println!("{:?}", resp.into_inner());
        }
        Commands::Subscribe => {
            let mut stream = client.subscribe_state(Request::new(SubscribeRequest { include_metrics: true })).await?.into_inner();
            while let Some(update) = stream.message().await? {
                println!("update: {:?}", update);
            }
        }
    }

    Ok(())
}
