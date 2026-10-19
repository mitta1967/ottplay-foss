//! Desktop media lives in this instance's private application-data directory.
use serde::Serialize;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct OfflineMediaState(Mutex<Option<String>>);
#[derive(Serialize)]
pub struct Endpoint {
    endpoint: String,
}

#[tauri::command]
pub async fn offline_media_endpoint(
    app: AppHandle,
    state: State<'_, OfflineMediaState>,
) -> Result<Endpoint, String> {
    let mut endpoint = state.0.lock().await;
    if let Some(value) = endpoint.as_ref() {
        return Ok(Endpoint {
            endpoint: value.clone(),
        });
    }
    let root = crate::instance::app_data_dir(&app)?.join("offline-media");
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let library = ottplay_core::offline_media::Library::new(root, token, "device")
        .await
        .map_err(|_| "Local media storage unavailable")?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Local media listener unavailable")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Local media listener unavailable")?;
    let value = format!("http://{address}{}", library.endpoint());
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, library.routes()).await {
            tracing::warn!(%error, "Offline media listener stopped");
        }
    });
    *endpoint = Some(value.clone());
    Ok(Endpoint { endpoint: value })
}
