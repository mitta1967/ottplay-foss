# Native offline media storage

Android and iOS expose the `LocalMedia` Capacitor plugin to the common offline
library. `list()`, `importFiles()` and `remove({ id })` return:

```json
{
  "available": true,
  "persistent": true,
  "storage": "device",
  "items": [{ "id": "UUID", "name": "Film.mp4", "size": 12345,
              "mime": "video/mp4", "url": "platform playback URL" }]
}
```

Import opens the system document picker and copies selected audio/video files
into application-private storage. The copy remains usable after the original
file is removed or its document provider goes offline. No all-files permission
or external-storage permission is requested. Import at most 128 files at once;
each file is limited to 8 GiB. A failed batch rolls back its imported files.
Interrupted private staging files are cleaned up on the next application launch.
Symbolic links and paths outside the private media directory are not exposed.
Uninstalling the application or clearing its data removes the library. The
application's existing Android backup exclusions and iOS backup exclusion keep
these potentially large video files out of cloud backups.

On Android (including API 22 Fire builds), the plugin serves only imported UUIDs
from a loopback listener on `127.0.0.1`. The port and unguessable URL token are
chosen per plugin lifetime. It supports GET, HEAD, single byte ranges, suffix
ranges and CORS preflight. Four streaming connections and an 8 KiB header budget
bound resource usage. It is not a LAN file share and cannot serve arbitrary
filesystem paths. Call `list()` after every application launch; do not persist
the ephemeral playback URLs as a replacement for item IDs.

On iOS, the plugin uses Capacitor's existing private-file URL handler, which
supports media byte ranges. The filename extension is retained for MIME
handling. Playback goes through the WebView media backend; these URLs are not
remote HTTP sources. Rebuild the native application to install the plugin;
updating a hosted HTML bundle alone cannot add native code.

H.264 video with AAC audio in MP4 is the recommended portable format. Importing a
file does not transcode it or add codecs to an old Fire WebView. Offline media
files need no Wi-Fi, Plex, NAS or command server while playing. Native app assets
must also be bundled locally; a remotely hosted UI is a separate offline-shell
concern.

## Verification

The Android unit suite exercises full, open, bounded, suffix, oversized and
invalid byte ranges, including files larger than 4 GiB. Device acceptance must
also cover importing a real MP4, seeking, force-stopping/relaunching with Wi-Fi
off, and screen sleep/resume. Compilation or byte-range tests alone do not prove
that every device's installed codecs can decode a selected file.
