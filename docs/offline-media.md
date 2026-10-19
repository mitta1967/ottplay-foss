# Local videos and offline playback

The **Local videos** library imports media files and exposes them as the
`offline` provider. Open **Settings → Local videos**, choose **Add files**, then
**Play local videos**. You can also select **Local videos** from the provider
list. When the library is empty, selecting this provider opens the import screen instead of an empty channel list. The player does not scan the computer: select files with **Add files** first. Chrome profiles, separate site addresses, and native apps have separate libraries. Channel identity is derived from the stored file ID; playback URLs are
refreshed every time the catalog loads. Existing channel selection, favourites
and kiosk rules apply to these entries.

Files are imported explicitly. This feature does not download IPTV channels,
copy Plex libraries, transcode video, or import multi-file HLS packages. Start
with H.264/AAC in an MP4 container for older Fire tablets. Supported codecs still
depend on the platform. Keep your original files as a backup. Browser autoplay rules may require pressing Play or Space after an offline reload.

## Where files live

- **Capacitor Android / iOS:** copied into application-private storage. The UI is
  bundled in the application. Playing imported files needs no Internet or NAS.
  Installing a native application build containing the new plugin is required;
  updating JavaScript alone cannot add it. See [native details](offline-media-native.md).
- **Tauri desktop:** copied through a streaming upload to the application-data
  library. A private loopback server serves only library IDs, supports byte
  ranges, and binds to `127.0.0.1`. Port and token change after application restart.
- **Browser / here.now / server-hosted player:** copied into IndexedDB for the
  current origin. The videos stay on the device; importing does not upload them
  to here.now. The browser may evict unprotected storage or the user may clear
  site data. The UI reports whether persistent storage was granted.
- **Optional Rust server library:** files live on the server disk. A remote
  player still needs a connection to this server. Use browser/device import for
  playback when the client must be completely disconnected.

A hosted browser needs HTTPS or localhost for its service worker. After the
first online app download completes and **Offline restart** is ready, keep the
same origin and test a reload with the network off. HTTP LAN pages can play
imported files while open, but cannot promise an offline cold start. An OS or
browser that lacks IndexedDB, service workers or the required codecs does not
become offline capable merely because the website supports this feature.

The worker revalidates public assets online even when hosting sets a long HTTP cache lifetime, and falls back to its installed assets when offline. After upgrading from the first preview, use a hard refresh (Cmd+Shift+R in Chrome on macOS) once to replace the old worker behavior without clearing local videos.

The worker caches a finite list of public player assets. It does not cache
playlists, live streams, credentials, command traffic or arbitrary requests.
Imported videos are separate from profile backups. Loading Home or another
preset does not copy or distribute the files to another device. Changing the
site origin creates a different browser library.

## Optional server library

Configure both variables before starting `ottplay-server`:

```sh
export OTT_OFFLINE_MEDIA_DIR=/srv/ottplay/local-media
# Supply a private random value of at least 32 URL-safe characters via your secret store.
export OTT_OFFLINE_MEDIA_TOKEN=YOUR_PRIVATE_RANDOM_TOKEN
```

In **Local videos → Server library…**, enter
`https://your-server/offline-media/YOUR_PRIVATE_RANDOM_TOKEN`.
Leave this setting empty to return to browser-local storage. Treat the full
URL as a credential: anyone holding it can list, import, play and delete library
files. Use HTTPS for remote access; do not publish this URL or include it in
public screenshots. A native Tauri client provisions its own loopback token
automatically and does not need these server variables.

The authenticated endpoint supports `GET` catalog, `POST /import?name=Film.mp4`
with raw file bytes, `GET /FILE_ID` with `Range`, and `DELETE /FILE_ID`. Imports
stream to disk instead of buffering an entire movie in memory. Server imports
accept MP4, M4V, WebM, OGV, MP3, M4A and OGG and are limited to 16 GiB per file; native mobile imports to 8 GiB. A server upload stalled for 60 seconds is cancelled. These limits are
not free-space guarantees. Files are addressed by opaque IDs; request URLs
cannot select arbitrary filesystem paths.

## Kiosk and updates

Select the offline provider, choose the required title, then apply the existing
kiosk command through the authorized command server. The persisted channel ID
survives a restart; the temporary playback URL is resolved again. Files must be
imported on every target device. Kiosk mode prevents changes through the local
library UI. Existing screen-off handling still governs playback while asleep.

Native code ships through APK/IPA/Tauri application updates. Browser UI changes
ship through the site; service-worker activation may require closing old tabs.
Neither type of update intentionally removes the library, but uninstalling,
clearing application data or clearing the site's storage does.

## Verification scope

Automated tests cover browser import, stable identity, offline app-shell reload,
actual media decoding, removal, provider replacement, and native HTTP range
handling. Native build checks do not prove every tablet's codec behavior. For a
new tablet validate: import MP4; play and seek; disable Wi-Fi; force-stop and
restart the app; verify the same selected item; test screen-off/resume. Secure
lock screens still require their configured authentication.
