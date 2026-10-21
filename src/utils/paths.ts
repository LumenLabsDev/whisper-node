import path from "path";

/**
 * True when a path contains a `..` segment after normalization.
 * Names that merely contain two dots, such as `take..2.wav`, are allowed.
 */
export function hasParentSegment(filePath: string): boolean {
  return path.normalize(filePath).split(/[\\/]+/).includes("..");
}
