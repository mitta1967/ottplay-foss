# A/V diagnostic fixture v1

`av-v1.mp4` is original synthetic media, licensed under the repository's MIT
license. Unlike the silent onboarding demo, this file has audible AAC stereo.
It runs for eight seconds at 640×360 / 25 fps, H.264 baseline, yuv420p.

| Time | Audio | Visible marker |
| --- | --- | --- |
| 0–2 seconds | Left, 440 Hz | Left half flashes |
| 2–4 seconds | Right, 880 Hz | Right half flashes |
| 4–6 seconds | Both | Both halves flash |
| 6–8 seconds | Silence | Moving pattern only |

Each second begins with a quiet 150 ms pulse (approximately −26 dBFS peak).
Start with the television at a comfortable volume; the application must not
raise system volume automatically. A mono television may reproduce both phases
from the same speaker. Digital decoding proves neither physical sound nor
physical display output; ask the observer to confirm those separately.

Regenerate with `bash scripts/generate-av-diagnostic.sh`, then verify with
`python3 scripts/check-av-diagnostic.py`. FFmpeg and FFprobe are needed only for
generation/verification, not playback. The verifier decodes the encoded audio
and checks routing, audible energy, silence and peak amplitude. Keep v1 stable;
materially different timings/encoding should use a new versioned filename.

The player streams the immutable v1 file from
https://mantra-basin-76mq.here.now/diagnostics/av-v1.mp4 only when the user starts
the A/V check. The file here is retained for reproducible verification and
manual offline tests, but is not staged into player packages.

Published bytes: 464,652. SHA-256:
`866c273d576d3db09a0e62596f011793d66f6fbb54db727ff2045e5d744105bb`.
The hosted file is byte-identical to this source and supports HTTPS, CORS and
HTTP Range requests. Do not replace v1 with different content; publish a new
versioned filename and update the player reference.
