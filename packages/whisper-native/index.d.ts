export interface WindowsArtifact {
  name: string;
  directory: string;
  arch: "ia32" | "x64";
  flavor: "cpu" | "blas";
  sha256: string;
}
export interface NativeRelease {
  version: string;
  sourceTag: string;
  binaryTag: string;
  commit: string;
  repository: string;
  windows: WindowsArtifact[];
}
export const release: NativeRelease;
export function resolveWindowsBinDir(baseDir: string, options?: { arch?: string; flavor?: string; directory?: string }): string;
export function verifyArchive(file: string, expected: string): void;
export function verifyArchitecture(executable: string, arch: string): void;
export function writeReceipt(directory: string, artifact: WindowsArtifact, pinned?: NativeRelease): void;
export function isCurrentInstall(directory: string, artifact: WindowsArtifact, pinned?: NativeRelease): boolean;
export function installWindows(baseDir: string, options?: { log?: (message: string) => void; smoke?: boolean }): Promise<void>;
/** Visual C++ runtime DLLs imported by the official Windows builds for an architecture. */
export function vcRuntimeFiles(arch: "ia32" | "x64" | string): string[];
/**
 * Copy the Visual C++ runtime DLLs next to the executables in `directory` (app-local deployment).
 * `source` is a folder such as Visual Studio's `VC\Redist\MSVC\<version>\x64`, or 'system'. Returns the copied names.
 */
export function installVcRuntime(directory: string, arch: "ia32" | "x64" | string, source?: string, options?: { log?: (message: string) => void }): string[];
/** Runtime DLLs of `arch` missing from `directory`. */
export function missingVcRuntime(directory: string, arch: "ia32" | "x64" | string): string[];
