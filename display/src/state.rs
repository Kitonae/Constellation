use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::watch;

use crate::proto::{Metrics, StateUpdate, TransportState, Project, TimelineTrack};
use crate::scene::{instances_from_project, InstanceData};

#[derive(Clone)]
pub struct AppState {
    shared: Arc<Shared>,
}

struct TransportInner {
    status: i32, // 0 STOPPED, 1 PLAYING, 2 PAUSED
    rate: f64,
    base_time: f64,
    started_at: Option<Instant>,
}

struct MetricsInner {
    fps: f64,
    dropped: f64,
}

struct Shared {
    inner: Mutex<Inner>,
    tx: watch::Sender<StateUpdate>,
}

struct Inner {
    transport: TransportInner,
    metrics: MetricsInner,
    instances: Vec<InstanceData>,
    project: Option<Project>,
}

impl AppState {
    pub fn new() -> (Self, watch::Receiver<StateUpdate>) {
        let (tx, rx) = watch::channel(StateUpdate {
            transport: Some(TransportState { status: 0, time_seconds: 0.0, rate: 1.0 }),
            metrics: Some(Metrics { fps: 0.0, dropped_frames: 0.0 }),
        });
        let inner = Inner {
            transport: TransportInner { status: 0, rate: 1.0, base_time: 0.0, started_at: None },
            metrics: MetricsInner { fps: 0.0, dropped: 0.0 },
            instances: Vec::new(),
            project: None,
        };
        let shared = Arc::new(Shared { inner: Mutex::new(inner), tx });
        (Self { shared }, rx)
    }

    pub fn set_metrics_fps(&self, fps: f64) {
        let mut g = self.shared.inner.lock().unwrap();
        g.metrics.fps = fps;
        drop(g);
        self.notify();
    }

    pub fn play(&self, at_seconds: Option<f64>) {
        let mut g = self.shared.inner.lock().unwrap();
    if let Some(at) = at_seconds { g.transport.base_time = at; }
    g.transport.started_at = Some(Instant::now());
    g.transport.status = 1;
        drop(g);
        self.notify();
    }

    pub fn pause(&self) {
        let mut g = self.shared.inner.lock().unwrap();
        if let Some(start) = g.transport.started_at.take() {
            g.transport.base_time += g.transport.rate * start.elapsed().as_secs_f64();
        }
        g.transport.status = 2;
        drop(g);
        self.notify();
    }

    pub fn stop(&self) {
        let mut g = self.shared.inner.lock().unwrap();
    g.transport.started_at = None;
    g.transport.base_time = 0.0;
    g.transport.status = 0;
        drop(g);
        self.notify();
    }

    pub fn seek(&self, to_seconds: f64) {
        let mut g = self.shared.inner.lock().unwrap();
    g.transport.base_time = to_seconds;
    if let Some(start) = g.transport.started_at.as_mut() {
            *start = Instant::now();
        }
        drop(g);
        self.notify();
    }

    pub fn set_rate(&self, rate: f64) {
        let mut g = self.shared.inner.lock().unwrap();
        {
            let t = &mut g.transport; // single mutable borrow
            if let Some(start) = t.started_at.as_mut() {
                let elapsed = start.elapsed().as_secs_f64();
                let old_rate = t.rate;
                t.base_time += old_rate * elapsed;
                *start = Instant::now();
            }
            t.rate = rate;
        }
        drop(g);
        self.notify();
    }

    fn notify(&self) {
        let upd = self.snapshot();
        let _ = self.shared.tx.send(upd);
    }

    fn snapshot(&self) -> StateUpdate {
        let g = self.shared.inner.lock().unwrap();
        let mut time = g.transport.base_time;
        if g.transport.status == 1 {
            if let Some(start) = g.transport.started_at {
                time += g.transport.rate * start.elapsed().as_secs_f64();
            }
        }
        StateUpdate {
            transport: Some(TransportState { status: g.transport.status, time_seconds: time, rate: g.transport.rate }),
            metrics: Some(Metrics { fps: g.metrics.fps, dropped_frames: g.metrics.dropped }),
        }
    }

    pub fn watch(&self) -> watch::Receiver<StateUpdate> { self.shared.tx.subscribe() }

    pub fn set_project(&self, project: &Project) {
        let instances = instances_from_project(project);
        let mut g = self.shared.inner.lock().unwrap();
        g.instances = instances;
        g.project = Some(project.clone());
    }

    pub fn instances(&self) -> Vec<InstanceData> {
        let g = self.shared.inner.lock().unwrap();
        g.instances.clone()
    }

    pub fn current_time(&self) -> f64 {
        let g = self.shared.inner.lock().unwrap();
        let mut time = g.transport.base_time;
        if g.transport.status == 1 {
            if let Some(start) = g.transport.started_at {
                time += g.transport.rate * start.elapsed().as_secs_f64();
            }
        }
        time
    }

    pub fn active_clip_for_node(&self, node_id: &str, t: f64) -> Option<(String, String)> {
        let g = self.shared.inner.lock().unwrap();
        let p = g.project.as_ref()?;
        let timeline = p.timeline.as_ref()?;
        let mut best: Option<(&crate::proto::TrackMedia, f64)> = None;
        for tr in &timeline.tracks {
            if let Some(timeline_track::Kind::Media(m)) = &tr.kind {
                if m.target_node_id == node_id {
                    let start = m.start_at_seconds + m.in_seconds;
                    let end = m.start_at_seconds + m.out_seconds;
                    if t >= start && t < end {
                        // prefer the latest starting clip if overlaps
                        if best.map(|(_, bs)| start >= bs).unwrap_or(true) {
                            best = Some((m, start));
                        }
                    }
                }
            }
        }
        let (m, _) = best?;
        let clip = p.media.iter().find(|c| c.id == m.clip_id)?;
        Some((clip.id.clone(), clip.uri.clone()))
    }
}
