# Tauri direct local sources

The desktop Local videos provider uses the operating system file/folder picker.
Selected videos remain in their original location: app data stores only small
JSON records, not copies of media. A folder selection scans media recursively;
non-media files and symlinks are skipped. Refresh scans the connected folders again and discovers new files. Existing
IDs and unavailable file references are retained; exact source paths are
deduplicated.

The picker is `tauri-plugin-dialog` 2.7.3, exposed through the application's
`offline_media_import_files` and `offline_media_import_folder` commands. There is
no HTTP API for submitting an arbitrary filesystem path. These commands return
the private loopback endpoint, and the UI fetches its catalog. They do not upload
the picked files to that endpoint.

The picker command schedules background discovery and returns without waiting
for the entire directory. The private catalog exposes cumulative items with
`scanning`, `scanned`, nullable `total`, and an optional `scanError`. While it is
scanning, the frontend polls every 250 ms and publishes changed snapshots. Adding
a folder starts playback when an eligible item becomes available; later entries
append without reopening the playing video. A restored selection still waits
for its saved item rather than choosing a different video.

The standard loading dialog displays processed catalog records and playable
video counts. These are not downloaded bytes: media stays in place. An unknown
total is omitted; unchanged polling does not reset the 60-second stall timeout.
Catalog polling does not start a second scan. Explicit Refresh requests a new
scan, and source changes preserve existing item IDs.

The existing Rust byte-range server opens the original files read-only. URLs use
opaque IDs and a random per-process token rather than filesystem paths. JSON
catalogs expose source names, availability, and item source IDs, not full paths.
The local server listens only on `127.0.0.1`.

`offline_media_remove_source` (and the authenticated DELETE source route) removes
the source's metadata and references. It never removes an original linked file.
Legacy private imports remain playable and can still be deleted as private
copies. Missing/moved originals remain listed unavailable instead of triggering
a copy. Reconnect the original drive/folder or choose a new source. macOS privacy
restrictions may require allowing folder access again; this is a desktop Tauri
implementation, not a sandbox security-scoped bookmark implementation.

The shared server distribution retains its explicit upload library. Server
uploads and native desktop source linking are different operations.

Verification completed: Rust core tests cover persisted links, nested scans,
byte-range reads, unavailable originals, unchanged source files after disconnect,
legacy upload behavior, and symlink exclusion. `cargo check -p ottplay-tauri`
passes. OS-picker UI and actual video decoding need native app verification.

Official picker API: https://v2.tauri.app/plugin/dialog/
