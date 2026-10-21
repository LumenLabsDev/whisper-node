# Security Policy

## Supported versions

Only the latest minor release line receives security fixes.

| Version | Supported |
| --- | --- |
| 0.5.x | Yes |
| < 0.5.0 | No. Upgrade to the latest 0.5.x release. |

Versions before 0.5.0 built the whisper.cpp command as a single shell string. Since 0.5.0, every native process (whisper.cpp, FFmpeg, CMake, tar) is started with literal argument arrays and `shell: false`.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for security problems.**

Report privately through GitHub:

1. Open [Report a vulnerability](https://github.com/LumenLabsDev/whisper-node/security/advisories/new) in the repository's **Security** tab.
2. Describe the issue, the affected version, and steps or a proof of concept to reproduce it.
3. Include the impact you expect (for example command execution, file overwrite or denial of service) and any suggested fix.

If you cannot use GitHub's private reporting, email **maximiliano.veiga@lumenlabs.dev** with the subject `[whisper-node security]`.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of your report | 3 business days |
| Initial assessment and severity | 7 days |
| Fix or mitigation for confirmed high/critical issues | 30 days |
| Public advisory | After a fixed release is available, coordinated with the reporter |

Confirmed vulnerabilities are published as [GitHub Security Advisories](https://github.com/LumenLabsDev/whisper-node/security/advisories). CVE IDs are requested through the GitHub CNA when the issue qualifies. Reporters are credited in the advisory unless they ask to remain anonymous.

Please keep the details private until the advisory is published. If a fix takes longer than expected, we will tell you why and agree on a new date with you.

## Scope

In scope:

- The JavaScript/TypeScript code in this repository and the published `@lumen-labs-dev/whisper-node` package (`src/`, `packages/`, `scripts/`).
- How the package invokes native tools, handles file paths, reads configuration and downloads models or native assets.
- Integrity checks for the pinned native release (`packages/whisper-native/release.json`).

Out of scope (report upstream instead):

- Bugs in [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [FFmpeg](https://ffmpeg.org/security.html) or [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) themselves.
- Model weights hosted on Hugging Face.
- Issues that need an attacker who already controls the process environment (for example `FFMPEG_PATH`, `WHISPER_WIN_BIN_DIR`, `WHISPER_NODE_CONFIG`) or the package installation directory.
- Resource usage from very large audio files beyond the documented limits.

## Guidance for applications

`whisper()` reads files from the paths you pass and, for non-WAV input, writes a sibling `*.wav16k.wav` file next to the source. When transcribing user uploads:

- Store uploads under a server-generated filename in a directory you control; do not reuse the client-supplied name as a path.
- Do not pass untrusted values to `modelPath` or `whisperOptions.output_file_path`, which select files the native process reads or writes.
- Run transcription with the least privileges the job needs.
