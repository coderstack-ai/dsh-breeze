# NOTICE

## What this plugin is

`dsh-breeze` is a DeepSeek Harness (DSH) plugin. It is a **client**: it speaks to a
running [`Breeze-TTS-2.cpp`](https://github.com/HoppouAI/Breeze-TTS-2.cpp) server
over that server's own HTTP API and does not contain, link, bundle or modify any
part of it.

Nothing from upstream is vendored here. No model weights, no GGUF, no audio
tokenizer, no source file. The plugin is a few thousand lines of plain
JavaScript that builds HTTP requests and wraps the PCM it gets back.

## Upstream projects

| Project | Role | License |
| --- | --- | --- |
| [Breeze-TTS-2.cpp](https://github.com/HoppouAI/Breeze-TTS-2.cpp) | The server this plugin talks to (not distributed here) | Apache-2.0; its MP3 encoder (`third_party/shine`) is LGPL-2.0 |
| [Breeze-TTS-2](https://huggingface.co/BreezeBlue/Breeze-TTS-2) | Model weights, downloaded by the server operator | BreezeBlue Research and Non-Commercial License |
| [ggml](https://github.com/ggml-org/ggml) | Inference backend inside the server | MIT |

## Licences that travel with the *server*, not with this plugin

The plugin is MIT. That says nothing about the model weights: **the Breeze TTS 2
weights are non-commercial**, and running them is the server operator's decision
and responsibility. If you record or upload reference audio to clone a voice, you
need that speaker's consent — the upstream project says so explicitly and so does
this notice.

## Deliberate design notes worth knowing before you rely on it

- **The endpoint has no authentication of its own.** Upstream says so plainly:
  neither the HTTP port nor the WebSocket port has auth or rate limiting. This
  plugin supports an optional `Authorization: Bearer <token>` so it can sit behind
  a reverse proxy that does have auth; without one, keep `breeze-server` bound to
  `127.0.0.1`.
- **Two field names, one endpoint.** `POST /v1/audio/speech` reads
  `instruction` (singular) on a form post and `instructions` (plural) in an
  OpenAI-style JSON body. Sending the wrong one is not an error: the server still
  answers 200 and silently ignores the direction. This plugin uses each name on
  its own path, and always sends the form path when it can, because that path
  also carries every sampling field and a reference clip.
- **Streamed WAV headers carry `0xFFFFFFFF` sizes.** When the server streams a
  WAV it cannot know the length up front, so both size fields are the maximum.
  The plugin asks for raw PCM and writes its own 44-byte header instead; when it
  does receive a WAV (the `mp3` path can fall back to WAV on a build without the
  MP3 encoder), it repairs both size fields before writing the file.
- **`409 busy` is retried, not failed.** Every generation slot being taken is a
  documented answer, not an error: the plugin retries with a short backoff.
