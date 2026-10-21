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
