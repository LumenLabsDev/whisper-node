# Contributing to whisper-node

Thanks for helping improve `@lumen-labs-dev/whisper-node`. Bug reports, documentation fixes, tests and pull requests are welcome.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security issues

Do not report vulnerabilities in public issues or pull requests. Follow [SECURITY.md](SECURITY.md) to report them privately.

## Reporting bugs and requesting features

Search [existing issues](https://github.com/LumenLabsDev/whisper-node/issues) first. When opening a new one, use the issue template and include:

- Package version, Node.js version and operating system/architecture.
- The model and options you used (`modelName`/`modelPath`, `whisperOptions`, diarization settings).
- A minimal reproduction and the full error output. Enable debug logs with `WHISPER_NODE_LOG_LEVEL=debug` when it helps.

For larger changes (new APIs, native release updates, new dependencies), open an issue first so the approach can be agreed before you spend time on it.

## Development setup

Requirements: Node.js 22 or newer, Git, and on macOS/Linux CMake plus a C/C++ compiler.

```sh
git clone https://github.com/LumenLabsDev/whisper-node.git
cd whisper-node
npm ci
npm run native:setup
npm test
```

See the [Development](README.md#development) section of the README for every script and the source layout.

## Pull requests

1. Fork the repository and create a branch from `master` (for example `fix/wav-header-parsing`).
2. Keep each pull request focused on one change.
3. Add or update tests in `test/` for behavior changes. Tests must use synthetic fixtures and must not download models.
4. Run `npm test` and `npm audit` before pushing.
5. Update `README.md` when you change public options, behavior or requirements.
6. Fill in the pull request template.

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `fix:`, `feat:`, `perf:`, `docs:`, `test:`, `chore:`, with a short imperative summary, for example `fix: reject empty language option`.

### Code guidelines

- TypeScript lives in `src/`; internal CommonJS helpers live in `packages/` with matching `.d.ts` declarations.
- Start external programs only through `packages/process` (`runProcess`), with arguments as an array. Never build command strings or use `shell: true`, `exec` or `execSync`.
- Validate caller-supplied input at the API boundary and throw the error classes from `src/utils/errors.ts`.
- Prefer Node.js built-ins over new dependencies. A new runtime dependency needs a clear reason in the pull request.
- Changes to the native release lock (`packages/whisper-native/release.json`) must update tags, commit and SHA-256 hashes together.

## Releases

Maintainers handle versioning and npm publishing. Versions follow [Semantic Versioning](https://semver.org/); security fixes ship as patch or minor releases of the supported line listed in [SECURITY.md](SECURITY.md).

## License

Contributions are accepted under the project's [MIT License](LICENSE).
