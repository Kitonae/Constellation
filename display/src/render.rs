use anyhow::Result;
use std::time::{Duration, Instant};
use wgpu::SurfaceConfiguration;
use wgpu::util::DeviceExt;
use glam::{Mat4, Vec3};
use winit::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::EventLoop,
    window::WindowBuilder,
};

use crate::state::AppState;
use std::collections::HashMap;

pub struct Renderer;

impl Renderer {
    pub fn run(app: AppState) -> Result<()> {
    let event_loop = EventLoop::new().expect("create event loop");
    let window = WindowBuilder::new()
            .with_title("Constellation Display")
            .with_inner_size(LogicalSize::new(1280.0, 720.0))
            .build(&event_loop)?;
    use std::sync::Arc;
    let window = Arc::new(window);

        // WGPU setup
        let instance = wgpu::Instance::default();
    let surface = instance.create_surface(window.as_ref())?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .expect("no adapter");

        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
            },
            None,
        ))?;

        let size = window.inner_size();
        let surface_caps = surface.get_capabilities(&adapter);
        let surface_format = surface_caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .unwrap_or(surface_caps.formats[0]);

        let mut config = SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::AutoVsync,
            alpha_mode: surface_caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        // Shaders and pipeline
        let shader_src = include_str!("shaders/quad.wgsl");
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("quad-shader"),
            source: wgpu::ShaderSource::Wgsl(shader_src.into()),
        });

        // Camera uniform
        let camera_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("camera-bgl"),
            entries: &[wgpu::BindGroupLayoutEntry{
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer{ ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            }],
        });
        let camera_buffer = device.create_buffer(&wgpu::BufferDescriptor{
            label: Some("camera-ubo"),
            size: std::mem::size_of::<[[f32;4];4]>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let camera_bg = device.create_bind_group(&wgpu::BindGroupDescriptor{
            label: Some("camera-bg"),
            layout: &camera_bgl,
            entries: &[wgpu::BindGroupEntry{ binding:0, resource: camera_buffer.as_entire_binding() }],
        });

        // Texture bind group layout (sampled 2D)
        let tex_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor{
            label: Some("tex-bgl"),
            entries: &[
                wgpu::BindGroupLayoutEntry{
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture{ multisampled: false, view_dimension: wgpu::TextureViewDimension::D2, sample_type: wgpu::TextureSampleType::Float { filterable: true } },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry{
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ]
        });

        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("quad-pipeline-layout"),
            bind_group_layouts: &[&camera_bgl, &tex_bgl],
            push_constant_ranges: &[],
        });
        let vertex_layouts = [
            // vertex: pos(xyz), uv
            wgpu::VertexBufferLayout{
                array_stride: (5*4) as u64,
                step_mode: wgpu::VertexStepMode::Vertex,
                attributes: &[
                    wgpu::VertexAttribute{ shader_location: 0, offset: 0, format: wgpu::VertexFormat::Float32x3 },
                    wgpu::VertexAttribute{ shader_location: 1, offset: (3*4) as u64, format: wgpu::VertexFormat::Float32x2 },
                ],
            },
            // instance: model mat4 as 4 vec4 attrs
            wgpu::VertexBufferLayout{
                array_stride: (16*4) as u64,
                step_mode: wgpu::VertexStepMode::Instance,
                attributes: &[
                    wgpu::VertexAttribute{ shader_location: 2, offset: 0, format: wgpu::VertexFormat::Float32x4 },
                    wgpu::VertexAttribute{ shader_location: 3, offset: (4*4) as u64, format: wgpu::VertexFormat::Float32x4 },
                    wgpu::VertexAttribute{ shader_location: 4, offset: (8*4) as u64, format: wgpu::VertexFormat::Float32x4 },
                    wgpu::VertexAttribute{ shader_location: 5, offset: (12*4) as u64, format: wgpu::VertexFormat::Float32x4 },
                ],
            },
        ];

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor{
            label: Some("quad-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState{ module: &shader, entry_point: "vs_main", buffers: &vertex_layouts },
            fragment: Some(wgpu::FragmentState{
                module: &shader,
                entry_point: "fs_main",
                targets: &[Some(wgpu::ColorTargetState{ format: surface_format, blend: Some(wgpu::BlendState::ALPHA_BLENDING), write_mask: wgpu::ColorWrites::ALL })],
            }),
            primitive: wgpu::PrimitiveState{ cull_mode: None, ..Default::default() },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
        });

        // A unit quad on XY plane centered at origin; Screen nodes scale it via model matrix
        let quad: [f32; 30] = [
            -0.5, -0.5, 0.0, 0.0, 0.0,
             0.5, -0.5, 0.0, 1.0, 0.0,
             0.5,  0.5, 0.0, 1.0, 1.0,
            -0.5, -0.5, 0.0, 0.0, 0.0,
             0.5,  0.5, 0.0, 1.0, 1.0,
            -0.5,  0.5, 0.0, 0.0, 1.0,
        ];
        let quad_vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor{
            label: Some("quad-vb"),
            contents: bytemuck::cast_slice(&quad),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let mut inst_vb = device.create_buffer(&wgpu::BufferDescriptor{
            label: Some("inst-vb"),
            size: 64 * 1024,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        // White 1x1 texture as fallback
        let white_tex = device.create_texture_with_data(
            &queue,
            &wgpu::TextureDescriptor{
                label: Some("white-tex"),
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &[255,255,255,255],
        );
        let white_view = white_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let linear_sampler = device.create_sampler(&wgpu::SamplerDescriptor{
            label: Some("linear-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let white_bg = device.create_bind_group(&wgpu::BindGroupDescriptor{
            label: Some("white-bg"),
            layout: &tex_bgl,
            entries: &[
                wgpu::BindGroupEntry{ binding:0, resource: wgpu::BindingResource::TextureView(&white_view) },
                wgpu::BindGroupEntry{ binding:1, resource: wgpu::BindingResource::Sampler(&linear_sampler) },
            ],
        });

        // Texture cache: clip_id -> bind group
        struct TexCache {
            map: HashMap<String, wgpu::BindGroup>,
        }
        impl TexCache {
            fn new() -> Self { Self { map: HashMap::new() } }
            fn get_or_load(
                &mut self,
                clip_id: &str,
                uri: &str,
                device: &wgpu::Device,
                queue: &wgpu::Queue,
                tex_bgl: &wgpu::BindGroupLayout,
                sampler: &wgpu::Sampler,
            ) -> Option<wgpu::BindGroup> {
                if let Some(bg) = self.map.get(clip_id) { return Some(bg.clone()); }
                if let Some((pixels, w, h)) = load_image_rgba(uri) {
                    let tex = device.create_texture_with_data(
                        queue,
                        &wgpu::TextureDescriptor{
                            label: Some("media-tex"),
                            size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
                            mip_level_count: 1,
                            sample_count: 1,
                            dimension: wgpu::TextureDimension::D2,
                            format: wgpu::TextureFormat::Rgba8UnormSrgb,
                            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                            view_formats: &[],
                        },
                        wgpu::util::TextureDataOrder::LayerMajor,
                        &pixels,
                    );
                    let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
                    let bg = device.create_bind_group(&wgpu::BindGroupDescriptor{
                        label: Some("media-bg"),
                        layout: tex_bgl,
                        entries: &[
                            wgpu::BindGroupEntry{ binding:0, resource: wgpu::BindingResource::TextureView(&view) },
                            wgpu::BindGroupEntry{ binding:1, resource: wgpu::BindingResource::Sampler(sampler) },
                        ],
                    });
                    self.map.insert(clip_id.to_string(), bg.clone());
                    return Some(bg);
                }
                None
            }
        }

        fn load_image_rgba(uri: &str) -> Option<(Vec<u8>, u32, u32)> {
            // Expect file:// URIs
            let path = if let Ok(u) = url::Url::parse(uri) {
                if u.scheme() == "file" {
                    u.to_file_path().ok()?
                } else { return None }
            } else {
                std::path::PathBuf::from(uri)
            };
            let img = image::open(path).ok()?.to_rgba8();
            let (w, h) = img.dimensions();
            Some((img.into_raw(), w, h))
        }

        let mut tex_cache = TexCache::new();

        let mut last_fps = Instant::now();
        let mut frames: u32 = 0;

        let win2 = window.clone();
        let res = event_loop.run(move |event, elwt| match event {
            Event::WindowEvent { event, .. } => match event {
                WindowEvent::CloseRequested => elwt.exit(),
                WindowEvent::Resized(new_size) => {
                    config.width = new_size.width.max(1);
                    config.height = new_size.height.max(1);
                    surface.configure(&device, &config);
                }
                WindowEvent::RedrawRequested => {
                    // Render frame
                    match surface.get_current_texture() {
                        Ok(frame) => {
                            let view_tex = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
                            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });

                            // Update camera
                            let eye = Vec3::new(6.0, 4.0, 10.0);
                            let target = Vec3::new(0.0, 2.0, 0.0);
                            let up = Vec3::Y;
                            let view_m = Mat4::look_at_rh(eye, target, up);
                            let aspect = config.width as f32 / config.height as f32;
                            let proj = Mat4::perspective_rh_gl(45f32.to_radians(), aspect.max(0.01), 0.1, 1000.0);
                            let vp = proj * view_m;
                            queue.write_buffer(&camera_buffer, 0, bytemuck::bytes_of(&vp.to_cols_array_2d()));

                            // Update instances from app state
                            let insts = app.instances();
                            let inst_raw: Vec<[[f32;4];4]> = insts.iter().map(|i| i.model).collect();
                            let needed = (inst_raw.len() * std::mem::size_of::<[[f32;4];4]>()) as u64;
                            if needed > inst_vb.size() {
                                inst_vb = device.create_buffer(&wgpu::BufferDescriptor{
                                    label: Some("inst-vb"),
                                    size: needed.next_power_of_two(),
                                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                                    mapped_at_creation: false,
                                });
                            }
                            if !inst_raw.is_empty() {
                                queue.write_buffer(&inst_vb, 0, bytemuck::cast_slice(&inst_raw));
                            }

                            // Render
                            {
                                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                                    label: Some("main-pass"),
                                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                        view: &view_tex,
                                        resolve_target: None,
                                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.02, g: 0.02, b: 0.03, a: 1.0 }), store: wgpu::StoreOp::Store },
                                    })],
                                    depth_stencil_attachment: None,
                                    timestamp_writes: None,
                                    occlusion_query_set: None,
                                });
                                rpass.set_pipeline(&pipeline);
                                rpass.set_bind_group(0, &camera_bg, &[]);
                                rpass.set_vertex_buffer(0, quad_vb.slice(..));
                                rpass.set_vertex_buffer(1, inst_vb.slice(..));
                                // Determine current time and draw each screen with its texture
                                let t_now = app.current_time();
                                for (i, inst) in insts.iter().enumerate() {
                                    let bg = if let Some((clip_id, uri)) = app.active_clip_for_node(&inst.node_id, t_now) {
                                        tex_cache.get_or_load(&clip_id, &uri, &device, &queue, &tex_bgl, &linear_sampler).unwrap_or_else(|| white_bg.clone())
                                    } else {
                                        white_bg.clone()
                                    };
                                    rpass.set_bind_group(1, &bg, &[]);
                                    let ii = i as u32;
                                    rpass.draw(0..6, ii..ii+1);
                                }
                            }
                            queue.submit(Some(encoder.finish()));
                            frame.present();

                            frames += 1;
                            if last_fps.elapsed() >= Duration::from_secs(1) {
                                let elapsed = last_fps.elapsed().as_secs_f64();
                                let fps = frames as f64 / elapsed.max(1e-6);
                                app.set_metrics_fps(fps);
                                frames = 0;
                                last_fps = Instant::now();
                            }
                        }
                        Err(err) => {
                            eprintln!("Surface error: {err:?}, reconfiguring...");
                            surface.configure(&device, &config);
                        }
                    }
                }
                _ => {}
            },
            Event::AboutToWait => {
                // Request a redraw on each loop (simple animation tick)
                win2.request_redraw();
            }
            _ => {}
        });
        // winit's event loop is 'never' returning; treat reaching here as success
        match res {
            Ok(_) => Ok(()),
            Err(e) => Err(anyhow::anyhow!("event loop error: {e}")),
        }
    }
}
