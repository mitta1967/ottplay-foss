# Manual audio/video check

[Русский](audio-video-check.ru.md) · [Stream recovery](playback-stream-policy.md)

Open **Information → Audio → Play** to stream the
[`av-v1.mp4` fixture](https://mantra-basin-76mq.here.now/diagnostics/av-v1.mp4). It is an explicit user action, never a startup
sound. The fixture uses the main HTML5 decoder and the current volume level;
its temporary unmute is restored when the check closes. Check the physical
screen and speakers: decoded frames or a successful player promise alone do
not demonstrate audible HDMI output.

The control is supported in the managed HTML5 path while idle or while a live
channel is playing/paused. It refuses VOD, archive and optional native engines.
If the current live request is still loading, stop it first to test while idle.
A refusal does not take over the existing decoder. Quality ceilings and live
backup URLs do not alter this known MP4 fixture.

The test ends naturally, or after a 15-second safety deadline if no end event
arrives. **Information → Audio → Stop** closes it and restores the original live
request, including its paused state, at the live edge. The ordinary playback
**Stop** button, standby and selection of another channel take precedence:
they cancel the check without restarting the old channel. A source or generation
change also prevents restoring the captured request. Idle checks return to idle.

The temporary lease emits no channel position, completion, history or OS media
metadata updates. It uses the existing main lane, so a second decoder does not
compete for hardware resources. Source credentials are resolved afresh when the
original live request returns. Muting during the check remains effective; the
demo's temporary startup mute is never stored as the user's permanent preference.

The source fixture, generator and validation remain in the repository; the video
is excluded from web, Tauri, Capacitor and container packages. An internet
connection and HTTPS access to here.now are required. A failed download does
not diagnose the decoder or speakers. Network errors close the check through
the same restoration path; a stalled request remains bounded by 15 seconds.
See the [hosting privacy details](privacy-policy.md#optional-hosted-audio-video-check).
Runtime ownership is covered by `tests/test_media_backend.cjs` and
`tests/test_port_engine_lifecycle.cjs`: normal completion, error, explicit test
cancellation, Stop, replacement, source changes, startup exceptions, VOD/archive
refusal, native-engine refusal, deadline and mute restoration. These tests do
not substitute for watching and listening on physical hardware.
