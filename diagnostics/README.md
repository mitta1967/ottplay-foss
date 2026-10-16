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
