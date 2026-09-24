# Read Frog local server

A single local service that gives Read Frog **AI subtitles** without the hosted
backend: it downloads a YouTube video's audio and transcribes it on this Mac with
[MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
(`whisper-large-v3-turbo` by default). No sign-in, no quota.

Everything it needs (yt-dlp, a static ffmpeg, MLX Whisper) lives in `./.venv`;
nothing is installed system-wide. Requires Apple silicon and [uv](https://docs.astral.sh/uv/).

```sh
./readfrog-local.sh setup    # once: dependencies + model (~1.6 GB)
./readfrog-local.sh start    # background service, also starts at login
./readfrog-local.sh status
./readfrog-local.sh stop
```

Then in Read Frog → Options → Video subtitles → **Local AI subtitles**, enter
`http://127.0.0.1:8765` and test the connection. On YouTube, open the subtitles
panel and choose **AI subtitles**. Translate the result with any provider,
including a local Ollama model.

## API

| Method | Path                                       | Result                                                             |
| ------ | ------------------------------------------ | ------------------------------------------------------------------ |
| `POST` | `/v1/transcripts` `{"url", "durationSec"}` | job `{id, status, detectedLanguage, error}`                        |
| `GET`  | `/v1/transcripts/<id>`                     | job status (`pending`/`processing`/`completed`/`failed`)           |
| `GET`  | `/v1/transcripts/<id>/subtitles`           | `{"segments": [{start, end, text}], "detectedLanguage"}` (seconds) |
| `GET`  | `/health`                                  | `{"ok": true, "model": "..."}`                                     |

It listens on `127.0.0.1` only, accepts only YouTube URLs and JSON bodies, and
caches finished transcripts in `~/Library/Application Support/ReadFrogLocal`.
Settings: `READ_FROG_LOCAL_PORT` (default 8765), `READ_FROG_WHISPER_MODEL`
(any MLX Whisper repo on Hugging Face).
