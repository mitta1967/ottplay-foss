//! Private, persistent local media with streaming imports and byte-range playback.
//! Requests can select opaque IDs only, never filesystem paths.
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Mutex,
};

const MAX_BYTES: u64 = 16 * 1024 * 1024 * 1024;
// An abandoned upload is never catalogued. Drop its file handle before the
// best-effort removal of its partial file (including cancelled requests).
struct PendingUpload {
    file: Option<fs::File>,
    path: PathBuf,
}
impl Drop for PendingUpload {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Clone)]
pub struct Library {
    root: PathBuf,
    token: String,
    storage: String,
    mutation: Arc<Mutex<()>>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Record {
    id: String,
    name: String,
    size: u64,
    mime: String,
    extension: String,
}
#[derive(Serialize)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub url: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub available: bool,
    pub items: Vec<Item>,
    pub storage: String,
    pub persistent: bool,
    pub upload_url: String,
}
#[derive(Deserialize)]
struct ImportQuery {
    name: String,
}

type Failure = (StatusCode, &'static str);
impl Library {
    pub async fn new(root: PathBuf, token: String, storage: &str) -> anyhow::Result<Self> {
        anyhow::ensure!(
            token.len() >= 32
                && token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "Offline media token must contain at least 32 URL-safe characters"
        );
        fs::create_dir_all(&root).await?;
        let root = fs::canonicalize(root).await?;
        Ok(Self {
            root,
            token,
            storage: storage.into(),
            mutation: Arc::new(Mutex::new(())),
        })
    }
    pub fn endpoint(&self) -> String {
        format!("/offline-media/{}", self.token)
    }
    pub fn routes(self) -> Router {
        Router::new()
            .route("/offline-media/:token", get(catalog).options(preflight))
            .route(
                "/offline-media/:token/import",
                post(import).options(preflight),
            )
            .route(
                "/offline-media/:token/:id",
                get(media).delete(remove).options(preflight),
            )
            .layer(DefaultBodyLimit::disable())
            .with_state(self)
    }
    fn authorize(&self, token: &str) -> Result<(), Failure> {
        // Fixed-length comparison avoids early exits on a matching prefix.
        let mut diff = self.token.len() ^ token.len();
        for (a, b) in self.token.bytes().zip(token.bytes()) {
            diff |= (a ^ b) as usize;
        }
        if diff != 0 {
            Err((StatusCode::NOT_FOUND, "Not found"))
        } else {
            Ok(())
        }
    }
    async fn records(&self) -> Result<Vec<Record>, Failure> {
        let mut directory = fs::read_dir(&self.root).await.map_err(storage_error)?;
        let mut out = Vec::new();
        while let Some(entry) = directory.next_entry().await.map_err(storage_error)? {
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let kind = match entry.file_type().await {
                Ok(kind) => kind,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(storage_error(e)),
            };
            if !kind.is_file() {
                continue;
            }
            let metadata = match entry.metadata().await {
                Ok(metadata) => metadata,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(storage_error(e)),
            };
            if metadata.len() > 4096 {
                continue;
            }
            let bytes = match fs::read(&path).await {
                Ok(bytes) => bytes,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(storage_error(e)),
            };
            if bytes.len() > 4096 {
                continue;
            }
            if let Ok(record) = serde_json::from_slice::<Record>(&bytes) {
                if valid_id(&record.id)
                    && media_type(&record.extension) == Some(record.mime.as_str())
                    && self.path(&record).await.is_ok()
                {
                    out.push(record);
                }
            }
        }
        out.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(out)
    }
    async fn path(&self, record: &Record) -> Result<PathBuf, Failure> {
        let path = self
            .root
            .join(format!("{}.{}", record.id, record.extension));
        let metadata = fs::symlink_metadata(&path)
            .await
            .map_err(|_| (StatusCode::NOT_FOUND, "Media not found"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err((StatusCode::NOT_FOUND, "Media not found"));
        }
        Ok(path)
    }
    async fn record(&self, id: &str) -> Result<Record, Failure> {
        if !valid_id(id) {
            return Err((StatusCode::NOT_FOUND, "Media not found"));
        }
        self.records()
            .await?
            .into_iter()
            .find(|r| r.id == id)
            .ok_or((StatusCode::NOT_FOUND, "Media not found"))
    }
    async fn catalog(&self) -> Result<Catalog, Failure> {
        let base = self.endpoint();
        let items = self
            .records()
            .await?
            .into_iter()
            .map(|r| Item {
                id: r.id.clone(),
                name: r.name,
                size: r.size,
                mime: r.mime,
                url: format!("{base}/{}", r.id),
            })
            .collect();
        Ok(Catalog {
            available: true,
            items,
            storage: self.storage.clone(),
            persistent: true,
            upload_url: format!("{base}/import"),
        })
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn storage_error<T>(_: T) -> Failure {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "Local media storage unavailable",
    )
}
fn media_type(extension: &str) -> Option<&'static str> {
    match extension {
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "ogv" => Some("video/ogg"),
        "mp3" => Some("audio/mpeg"),
        "m4a" => Some("audio/mp4"),
        "ogg" => Some("audio/ogg"),
        _ => None,
    }
}
fn cors(response: &mut Response) {
    let h = response.headers_mut();
    h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    h.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, HEAD, POST, DELETE, OPTIONS"),
    );
    h.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Content-Type, Range"),
    );
    h.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("Content-Length, Content-Range, Accept-Ranges"),
    );
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
}
async fn preflight(
    State(l): State<Library>,
    Path(params): Path<std::collections::HashMap<String, String>>,
) -> Response {
    let mut r = match l.authorize(params.get("token").map(String::as_str).unwrap_or("")) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}
async fn catalog(State(l): State<Library>, Path(token): Path<String>) -> Response {
    let mut r = match l.authorize(&token) {
        Ok(()) => match l.catalog().await {
            Ok(c) => Json(c).into_response(),
            Err(e) => e.into_response(),
        },
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}
async fn import(
    State(l): State<Library>,
    Path(token): Path<String>,
    Query(q): Query<ImportQuery>,
    body: Body,
) -> Response {
    let result = import_inner(&l, &token, &q.name, body).await;
    let mut r = match result {
        Ok(c) => Json(c).into_response(),
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}
async fn import_inner(
    l: &Library,
    token: &str,
    name: &str,
    body: Body,
) -> Result<Catalog, Failure> {
    l.authorize(token)?;
    if name.is_empty()
        || name.len() > 240
        || name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid media filename"));
    }
    let extension = FsPath::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = media_type(&extension).ok_or((
        StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "Use MP4, WebM, OGV, MP3, M4A or OGG",
    ))?;
    let _lock = l.mutation.lock().await;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let temporary = l.root.join(format!("{id}.upload"));
    let target = l.root.join(format!("{id}.{extension}"));
    // Ownership is established inside the blocking task, so cancellation while
    // creating the file still drops a guard instead of leaving an orphan.
    let upload_path = temporary.clone();
    let mut upload = tokio::task::spawn_blocking(move || {
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&upload_path)?;
        Ok::<_, std::io::Error>(PendingUpload {
            file: Some(fs::File::from_std(file)),
            path: upload_path,
        })
    })
    .await
    .map_err(storage_error)?
    .map_err(storage_error)?;
    let write_result: Result<u64, Failure> = async {
        let mut size = 0u64;
        let mut chunks = body.into_data_stream();
        while let Some(chunk) =
            tokio::time::timeout(std::time::Duration::from_secs(60), chunks.next())
                .await
                .map_err(|_| (StatusCode::REQUEST_TIMEOUT, "Upload stalled"))?
        {
            let chunk = chunk.map_err(|_| (StatusCode::BAD_REQUEST, "Upload interrupted"))?;
            size = size
                .checked_add(chunk.len() as u64)
                .filter(|s| *s <= MAX_BYTES)
                .ok_or((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Maximum media size is 16 GiB",
                ))?;
            upload
                .file
                .as_mut()
                .unwrap()
                .write_all(&chunk)
                .await
                .map_err(storage_error)?;
        }
        if size == 0 {
            return Err((StatusCode::BAD_REQUEST, "Media file is empty"));
        }
        upload
            .file
            .as_mut()
            .unwrap()
            .flush()
            .await
            .map_err(storage_error)?;
        Ok(size)
    }
    .await;
    drop(upload.file.take());
    let size = match write_result {
        Ok(size) => size,
        Err(e) => {
            let _ = fs::remove_file(&temporary).await;
            return Err(e);
        }
    };
    fs::rename(&temporary, &target)
        .await
        .map_err(storage_error)?;
    let record = Record {
        id: id.clone(),
        name: name.into(),
        size,
        mime: mime.into(),
        extension,
    };
    let encoded = serde_json::to_vec(&record).map_err(storage_error)?;
    if let Err(e) = fs::write(l.root.join(format!("{id}.json")), encoded).await {
        let _ = fs::remove_file(target).await;
        return Err(storage_error(e));
    }
    l.catalog().await
}
async fn remove(State(l): State<Library>, Path((token, id)): Path<(String, String)>) -> Response {
    let result: Result<Catalog, Failure> = async {
        l.authorize(&token)?;
        let _lock = l.mutation.lock().await;
        let record = l.record(&id).await?;
        fs::remove_file(l.path(&record).await?)
            .await
            .map_err(storage_error)?;
        fs::remove_file(l.root.join(format!("{id}.json")))
            .await
            .map_err(storage_error)?;
        l.catalog().await
    }
    .await;
    let mut r = match result {
        Ok(c) => Json(c).into_response(),
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}
fn byte_range(value: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, Failure> {
    let Some(value) = value else { return Ok(None) };
    let fail = || (StatusCode::RANGE_NOT_SATISFIABLE, "Invalid byte range");
    let raw = value.strip_prefix("bytes=").ok_or_else(fail)?;
    if raw.contains(',') || size == 0 {
        return Err(fail());
    }
    let (a, b) = raw.split_once('-').ok_or_else(fail)?;
    let range = if a.is_empty() {
        let length = b.parse::<u64>().map_err(|_| fail())?;
        if length == 0 {
            return Err(fail());
        }
        (size.saturating_sub(length), size - 1)
    } else {
        let start = a.parse::<u64>().map_err(|_| fail())?;
        let end = if b.is_empty() {
            size - 1
        } else {
            b.parse::<u64>().map_err(|_| fail())?.min(size - 1)
        };
        if start >= size || end < start {
            return Err(fail());
        }
        (start, end)
    };
    Ok(Some(range))
}
async fn media(
    State(l): State<Library>,
    Path((token, id)): Path<(String, String)>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    let result: Result<Response, Failure> = async {
        l.authorize(&token)?;
        let record = l.record(&id).await?;
        let mut file = fs::File::open(l.path(&record).await?)
            .await
            .map_err(storage_error)?;
        let size = file.metadata().await.map_err(storage_error)?.len();
        let range = match byte_range(headers.get("range").and_then(|v| v.to_str().ok()), size) {
            Ok(r) => r,
            Err(e) => {
                let mut r = e.into_response();
                r.headers_mut()
                    .insert("content-range", format!("bytes */{size}").parse().unwrap());
                return Ok(r);
            }
        };
        let (start, end) = range.unwrap_or((0, size.saturating_sub(1)));
        let length = if size == 0 { 0 } else { end - start + 1 };
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(storage_error)?;
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            Body::from_stream(stream::try_unfold(
                (file, length),
                |(mut file, left)| async move {
                    if left == 0 {
                        return Ok::<_, std::io::Error>(None);
                    }
                    let mut bytes = vec![0; left.min(64 * 1024) as usize];
                    let read = file.read(&mut bytes).await?;
                    if read == 0 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "Local media truncated",
                        ));
                    }
                    bytes.truncate(read);
                    Ok(Some((Bytes::from(bytes), (file, left - read as u64))))
                },
            ))
        };
        let mut r = Response::new(body);
        *r.status_mut() = if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        };
        let h = r.headers_mut();
        h.insert("content-type", record.mime.parse().unwrap());
        h.insert("content-length", length.into());
        h.insert("accept-ranges", HeaderValue::from_static("bytes"));
        if range.is_some() {
            h.insert(
                "content-range",
                format!("bytes {start}-{end}/{size}").parse().unwrap(),
            );
        }
        Ok(r)
    }
    .await;
    let mut r = match result {
        Ok(r) => r,
        Err(e) => e.into_response(),
    };
    cors(&mut r);
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges() {
        assert_eq!(byte_range(Some("bytes=2-4"), 10).unwrap(), Some((2, 4)));
        assert_eq!(byte_range(Some("bytes=-3"), 10).unwrap(), Some((7, 9)));
        assert_eq!(byte_range(Some("bytes=8-"), 10).unwrap(), Some((8, 9)));
        assert!(byte_range(Some("bytes=10-"), 10).is_err());
        assert!(byte_range(Some("bytes=1-2,4-5"), 10).is_err());
    }
    #[tokio::test]
    async fn imports_persist_and_reject_paths() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let l = Library::new(root.clone(), "a".repeat(32), "device")
            .await
            .unwrap();
        assert!(
            import_inner(&l, &"b".repeat(32), "a.mp4", Body::from("123"))
                .await
                .is_err()
        );
        assert!(
            import_inner(&l, &"a".repeat(32), "../a.mp4", Body::from("123"))
                .await
                .is_err()
        );
        let catalog = import_inner(&l, &"a".repeat(32), "cartoon.mp4", Body::from("12345"))
            .await
            .unwrap();
        assert_eq!(catalog.items.len(), 1);
        assert_eq!(catalog.items[0].size, 5);
        let reopened = Library::new(root.clone(), "a".repeat(32), "device")
            .await
            .unwrap();
        assert_eq!(reopened.catalog().await.unwrap().items.len(), 1);
        fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn http_upload_range_head_delete_and_preflight() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let l = Library::new(root.clone(), "c".repeat(32), "device")
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let base = format!("{origin}{}", l.endpoint());
        let task = tokio::spawn(async move { axum::serve(listener, l.routes()).await.unwrap() });
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .get(format!("{origin}/offline-media/{}", "x".repeat(32)))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let upload = client
            .post(format!("{base}/import?name=test.mp4"))
            .body("0123456789")
            .send()
            .await
            .unwrap();
        assert_eq!(upload.status(), StatusCode::OK);
        let catalog: serde_json::Value = upload.json().await.unwrap();
        let url = format!("{origin}{}", catalog["items"][0]["url"].as_str().unwrap());
        let range = client
            .get(&url)
            .header("Range", "bytes=2-5")
            .send()
            .await
            .unwrap();
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range.headers()["content-range"], "bytes 2-5/10");
        assert_eq!(range.bytes().await.unwrap(), "2345");
        let invalid = client
            .get(&url)
            .header("Range", "bytes=20-")
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(invalid.headers()["content-range"], "bytes */10");
        let head = client.head(&url).send().await.unwrap();
        assert_eq!(head.headers()["content-length"], "10");
        assert!(head.bytes().await.unwrap().is_empty());
        let options = client
            .request(reqwest::Method::OPTIONS, &url)
            .send()
            .await
            .unwrap();
        assert_eq!(options.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            client.delete(&url).send().await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(
            client.get(&url).send().await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        task.abort();
        fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn cancelled_upload_removes_partial_file() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let l = Library::new(root.clone(), "d".repeat(32), "device")
            .await
            .unwrap();
        let body = Body::from_stream(
            stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from_static(
                b"partial",
            ))])
            .chain(stream::pending()),
        );
        let task =
            tokio::spawn(async move { import_inner(&l, &"d".repeat(32), "test.mp4", body).await });
        let mut started = false;
        for _ in 0..100 {
            if fs::read_dir(&root)
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_some()
            {
                started = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(started);
        task.abort();
        let _ = task.await;
        let mut clean = false;
        for _ in 0..100 {
            if fs::read_dir(&root)
                .await
                .unwrap()
                .next_entry()
                .await
                .unwrap()
                .is_none()
            {
                clean = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(clean);
        fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn rejects_unsafe_tokens_and_path_ids() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        assert!(Library::new(root.clone(), "short".into(), "device")
            .await
            .is_err());
        assert!(Library::new(root.clone(), "a/".repeat(32), "device")
            .await
            .is_err());
        let l = Library::new(root.clone(), "e".repeat(32), "device")
            .await
            .unwrap();
        assert!(l.authorize(&"e".repeat(31)).is_err());
        assert!(l.authorize(&format!("{}x", "e".repeat(32))).is_err());
        let result = media(
            State(l),
            Path(("e".repeat(32), "../private".into())),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(result.status(), StatusCode::NOT_FOUND);
        fs::remove_dir_all(root).await.unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn never_serves_symlinked_media_or_metadata() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let outside = root.with_extension("private");
        let l = Library::new(root.clone(), "f".repeat(32), "device")
            .await
            .unwrap();
        let catalog = import_inner(&l, &"f".repeat(32), "movie.mp4", Body::from("movie"))
            .await
            .unwrap();
        let id = catalog.items[0].id.clone();
        let path = root.join(format!("{id}.mp4"));
        fs::write(&outside, "private data").await.unwrap();
        fs::remove_file(&path).await.unwrap();
        std::os::unix::fs::symlink(&outside, &path).unwrap();
        assert!(l.catalog().await.unwrap().items.is_empty());
        let result = media(
            State(l.clone()),
            Path(("f".repeat(32), id.clone())),
            HeaderMap::new(),
            Method::GET,
        )
        .await;
        assert_eq!(result.status(), StatusCode::NOT_FOUND);
        fs::remove_file(&path).await.unwrap();
        fs::write(&path, "movie").await.unwrap();
        let metadata = root.join(format!("{id}.json"));
        let saved = fs::read(&metadata).await.unwrap();
        fs::write(&outside, saved).await.unwrap();
        fs::remove_file(&metadata).await.unwrap();
        std::os::unix::fs::symlink(&outside, &metadata).unwrap();
        assert!(l.catalog().await.unwrap().items.is_empty());
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_file(outside).await.unwrap();
    }
}
