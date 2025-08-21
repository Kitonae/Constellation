use crate::proto::*;
use glam::{Mat4, Quat, Vec3};

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct InstanceGpu {
    pub model: [[f32; 4]; 4],
}

#[derive(Clone)]
pub struct InstanceData {
    pub model: [[f32; 4]; 4],
    pub node_id: String,
}

fn mat4_from_transform(t: &Transform) -> Mat4 {
    let p = t.position.as_ref().map(|v| Vec3::new(v.x, v.y, v.z)).unwrap_or(Vec3::ZERO);
    let r = t.rotation.as_ref().map(|q| Quat::from_xyzw(q.x, q.y, q.z, q.w)).unwrap_or(Quat::IDENTITY);
    let s = t.scale.as_ref().map(|v| Vec3::new(v.x, v.y, v.z)).unwrap_or(Vec3::ONE);
    Mat4::from_scale_rotation_translation(s, r, p)
}

pub fn instances_from_project(p: &Project) -> Vec<InstanceData> {
    let mut out = Vec::new();
    if let Some(scene) = &p.scene {
        for n in &scene.roots {
            collect_instances(n, Mat4::IDENTITY, &mut out);
        }
    }
    out
}

fn collect_instances(node: &Node, parent: Mat4, out: &mut Vec<InstanceData>) {
    let local = node.transform.as_ref().map(mat4_from_transform).unwrap_or(Mat4::IDENTITY);
    let world = parent * local;
    match &node.comp0 {
        Some(node::Comp0::Screen(_s)) => {
            out.push(InstanceData { model: world.to_cols_array_2d(), node_id: node.id.clone() });
        }
        _ => {}
    }
    for c in &node.children {
        collect_instances(c, world, out);
    }
}
