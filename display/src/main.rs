use std::net::SocketAddr;
use std::thread;
use tonic::{transport::Server, Request, Response, Status};

mod render;
mod scene;
mod state;
use render::Renderer;
use state::AppState;

pub mod proto {
    tonic::include_proto!("constellation.v1");
}

use proto::display_control_server::{DisplayControl, DisplayControlServer};
use futures_core::Stream;
use std::pin::Pin;
use async_stream::stream;
use proto::*;

struct DisplaySvc {
    app: AppState,
}

#[tonic::async_trait]
impl DisplayControl for DisplaySvc {
    async fn load_project(&self, req: Request<LoadProjectRequest>) -> Result<Response<Ack>, Status> {
        if let Some(project) = &req.get_ref().project {
            self.app.set_project(project);
            Ok(Response::new(Ack { ok: true, message: "project loaded".into() }))
        } else {
            Ok(Response::new(Ack { ok: false, message: "missing project".into() }))
        }
    }
    async fn load_scene(&self, _req: Request<LoadSceneRequest>) -> Result<Response<Ack>, Status> {
        Ok(Response::new(Ack { ok: true, message: "scene loaded".into() }))
    }
    async fn activate_timeline(&self, _req: Request<ActivateTimelineRequest>) -> Result<Response<Ack>, Status> {
        Ok(Response::new(Ack { ok: true, message: "timeline activated".into() }))
    }
    async fn play(&self, req: Request<PlayRequest>) -> Result<Response<Ack>, Status> {
        let at = if req.get_ref().at_seconds > 0.0 { Some(req.get_ref().at_seconds) } else { None };
        self.app.play(at);
        Ok(Response::new(Ack { ok: true, message: "play".into() }))
    }
    async fn pause(&self, _req: Request<PauseRequest>) -> Result<Response<Ack>, Status> {
        self.app.pause();
        Ok(Response::new(Ack { ok: true, message: "pause".into() }))
    }
    async fn stop(&self, _req: Request<StopRequest>) -> Result<Response<Ack>, Status> {
        self.app.stop();
        Ok(Response::new(Ack { ok: true, message: "stop".into() }))
    }
    async fn seek(&self, req: Request<SeekRequest>) -> Result<Response<Ack>, Status> {
        self.app.seek(req.get_ref().to_seconds);
        Ok(Response::new(Ack { ok: true, message: "seek".into() }))
    }
    async fn set_rate(&self, req: Request<SetRateRequest>) -> Result<Response<Ack>, Status> {
        self.app.set_rate(req.get_ref().rate);
        Ok(Response::new(Ack { ok: true, message: "rate set".into() }))
    }
    type SubscribeStateStream = Pin<Box<dyn Stream<Item = Result<StateUpdate, Status>> + Send + 'static>>;
    async fn subscribe_state(&self, _req: Request<SubscribeRequest>) -> Result<Response<Self::SubscribeStateStream>, Status> {
        let mut rx = self.app.watch();
        let s = stream! {
            loop {
                // wait for change
                let _ = rx.changed().await;
                let v = rx.borrow().clone();
                yield Ok(v);
            }
        };
        Ok(Response::new(Box::pin(s) as Self::SubscribeStateStream))
    }
}

fn start_rpc_server(addr: SocketAddr, app: AppState) {
    thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move {
            let svc = DisplaySvc { app };
            println!("Display gRPC listening on http://{addr}");
            if let Err(e) = Server::builder()
                .add_service(DisplayControlServer::new(svc))
                .serve(addr)
                .await
            {
                eprintln!("RPC server error: {e}");
            }
        });
    });
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = "0.0.0.0:50051".parse()?;
    let (app, _rx) = AppState::new();
    start_rpc_server(addr, app.clone());
    // Run renderer on main thread (required by some platforms)
    Renderer::run(app)?;
    Ok(())
}
