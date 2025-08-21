#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

pub mod proto { tonic::include_proto!("constellation.v1"); }
use proto::display_control_client::DisplayControlClient;
use proto::*;

#[tauri::command]
async fn apply_project(addr: String, project_json: String) -> Result<String, String> {
    // Parse editor-facing JSON and convert to proto Project
    let project: Project = match json_to_project(&project_json) {
        Ok(p) => p,
        Err(e) => return Err(format!("parse error: {e}")),
    };
    let mut client = DisplayControlClient::connect(addr).await.map_err(|e| e.to_string())?;
    let req = tonic::Request::new(LoadProjectRequest { project: Some(project) });
    let ack = client.load_project(req).await.map_err(|e| e.to_string())?.into_inner();
    if ack.ok { Ok(ack.message) } else { Err(ack.message) }
}

#[tauri::command]
async fn play(addr: String, at: Option<f64>) -> Result<String, String> {
    let mut client = DisplayControlClient::connect(addr).await.map_err(|e| e.to_string())?;
    let ack = client.play(tonic::Request::new(PlayRequest { at_seconds: at.unwrap_or(0.0) }))
        .await.map_err(|e| e.to_string())?.into_inner();
    if ack.ok { Ok(ack.message) } else { Err(ack.message) }
}

#[tauri::command]
async fn pause(addr: String) -> Result<String, String> {
    let mut client = DisplayControlClient::connect(addr).await.map_err(|e| e.to_string())?;
    let ack = client.pause(tonic::Request::new(PauseRequest {})).await.map_err(|e| e.to_string())?.into_inner();
    if ack.ok { Ok(ack.message) } else { Err(ack.message) }
}

#[tauri::command]
async fn stop(addr: String) -> Result<String, String> {
    let mut client = DisplayControlClient::connect(addr).await.map_err(|e| e.to_string())?;
    let ack = client.stop(tonic::Request::new(StopRequest {})).await.map_err(|e| e.to_string())?.into_inner();
    if ack.ok { Ok(ack.message) } else { Err(ack.message) }
}

#[tauri::command]
async fn seek(addr: String, to: f64) -> Result<String, String> {
    let mut client = DisplayControlClient::connect(addr).await.map_err(|e| e.to_string())?;
    let ack = client.seek(tonic::Request::new(SeekRequest { to_seconds: to })).await.map_err(|e| e.to_string())?.into_inner();
    if ack.ok { Ok(ack.message) } else { Err(ack.message) }
}

#[tauri::command]
async fn set_rate(addr: String, rate: f64) -> Result<String, String> {
    let mut client = DisplayControlClient::connect(addr).await.map_err(|e| e.to_string())?;
    let ack = client.set_rate(tonic::Request::new(SetRateRequest { rate })).await.map_err(|e| e.to_string())?.into_inner();
    if ack.ok { Ok(ack.message) } else { Err(ack.message) }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![apply_project, play, pause, stop, seek, set_rate])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ------------ JSON to proto conversion (mirror of CLI mapper) ------------
fn json_to_project(s: &str) -> Result<Project, anyhow::Error> {
    #[derive(Debug, serde::Deserialize)]
    struct Vec3J { x: f32, y: f32, z: f32 }
    #[derive(Debug, serde::Deserialize)]
    struct QuatJ { x: f32, y: f32, z: f32, w: f32 }
    #[derive(Debug, serde::Deserialize)]
    struct TransformJ { position: Vec3J, rotation: QuatJ, scale: Vec3J }
    #[derive(Debug, serde::Deserialize)]
    struct ColorJ { r: f32, g: f32, b: f32, a: f32 }
    #[derive(Debug, serde::Deserialize)]
    struct MaterialPbrJ { id: String, name: Option<String>, base_color: Option<ColorJ>, metallic: Option<f32>, roughness: Option<f32>, emissive: Option<ColorJ> }
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
    struct NodeJ { id: String, name: Option<String>, transform: TransformJ, #[serde(default)] children: Vec<NodeJ>, mesh: Option<MeshCompJ>, light: Option<LightCompJ>, screen: Option<ScreenCompJ>, camera: Option<CameraCompJ> }
    #[derive(Debug, serde::Deserialize)]
    struct SceneJ { id: String, name: Option<String>, #[serde(default)] materials: Vec<MaterialPbrJ>, #[serde(default)] meshes: Vec<MeshRefJ>, #[serde(default)] roots: Vec<NodeJ> }
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

    let wrapper: ProjectWrapperJ = serde_json::from_str(s)?;

    fn v3(v: Vec3J) -> Vec3 { Vec3 { x: v.x, y: v.y, z: v.z } }
    fn q(q: QuatJ) -> Quat { Quat { x: q.x, y: q.y, z: q.z, w: q.w } }
    fn t(t: TransformJ) -> Transform { Transform { position: Some(v3(t.position)), rotation: Some(q(t.rotation)), scale: Some(v3(t.scale)) } }
    fn col(c: ColorJ) -> ColorRgba { ColorRgba { r: c.r, g: c.g, b: c.b, a: c.a } }
    fn mat(m: MaterialPbrJ) -> MaterialPbr { MaterialPbr { id: m.id, name: m.name.unwrap_or_default(), base_color: m.base_color.map(col), base_color_tex: None, metallic: m.metallic.unwrap_or(0.0), roughness: m.roughness.unwrap_or(1.0), mr_tex: None, emissive: m.emissive.map(col), emissive_tex: None } }
    fn mesh(m: MeshRefJ) -> MeshRef { MeshRef { id: m.id, uri: m.uri, node: m.node.unwrap_or_default() } }
    fn node(n: NodeJ) -> Node {
        let mut node = Node { id: n.id, name: n.name.unwrap_or_default(), transform: Some(t(n.transform)), children: n.children.into_iter().map(node).collect(), comp0: None };
        if let Some(s) = n.screen { node.comp0 = Some(node::Comp0::Screen(ScreenComponent { pixels_x: s.pixels_x, pixels_y: s.pixels_y })); }
        if let Some(l) = n.light { let lt = match l.r#type.as_str() { "DIRECTIONAL" => 1, "SPOT" => 2, _ => 0 }; node.comp0 = Some(node::Comp0::Light(LightComponent { r#type: lt, color: Some(col(l.color)), intensity: l.intensity, range: l.range, spot_angle: l.spot_angle.unwrap_or(0.0) })); }
        if let Some(c) = n.camera { node.comp0 = Some(node::Comp0::Camera(CameraComponent { fov_deg: c.fov_deg, near: c.near, far: c.far })); }
        if let Some(m) = n.mesh { node.comp0 = Some(node::Comp0::Mesh(MeshComponent { mesh: Some(mesh(m.mesh)), material_id: m.material_id.unwrap_or_default() })); }
        node
    }
    fn scene(s: SceneJ) -> Scene { Scene { id: s.id, name: s.name.unwrap_or_default(), materials: s.materials.into_iter().map(mat).collect(), meshes: s.meshes.into_iter().map(mesh).collect(), roots: s.roots.into_iter().map(node).collect() } }

    let p = wrapper.project;
    let media = p.media.into_iter().map(|m| MediaClip { id: m.id, name: m.name.unwrap_or_default(), uri: m.uri, duration_seconds: m.duration_seconds }).collect();
    let tracks = p.timeline.tracks.into_iter().filter_map(|t| t.media.map(|m| TimelineTrack { kind: Some(timeline_track::Kind::Media(TrackMedia { target_node_id: m.target_node_id, clip_id: m.clip_id, in_seconds: m.in_seconds, out_seconds: m.out_seconds, start_at_seconds: m.start_at_seconds })) })).collect();
    let events = p.timeline.events.into_iter().map(|e| TimelineEvent { t: e.t, action: e.action, params: e.params }).collect();
    Ok(Project { id: p.id, name: p.name.unwrap_or_default(), scene: Some(scene(p.scene)), media, timeline: Some(Timeline { id: p.timeline.id, name: p.timeline.name.unwrap_or_default(), tracks, events, duration_seconds: p.timeline.duration_seconds }) })
}
