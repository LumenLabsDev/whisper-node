import fs from "fs";
import path from "path";
import { IFlagTypes } from "../core/whisper";
import { IShellOptions } from "../infra/shell";

export type IWhisperConfig = {
  modelName?: string;
  modelPath?: string;
  whisperOptions?: IFlagTypes;
  shellOptions?: Partial<IShellOptions>;
};

const DEFAULT_CONFIG_BASENAMES = [
  "whisper-node.config.json",
  "whisper.config.json",
];

function findConfigPath(): string | null {
  const fromEnv = process.env.WHISPER_NODE_CONFIG;
  if (fromEnv) {
    try {
      const p = path.resolve(fromEnv);
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  const cwd = process.cwd();
  for (const base of DEFAULT_CONFIG_BASENAMES) {
    const p = path.join(cwd, base);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(): IWhisperConfig {
  const configPath = findConfigPath();
  if (!configPath) return {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const json = JSON.parse(raw);
    const cfg: IWhisperConfig = {};

    if (typeof json.modelName === "string") cfg.modelName = json.modelName;
    if (typeof json.modelPath === "string") cfg.modelPath = json.modelPath;
    if (typeof json.whisperOptions === "object") cfg.whisperOptions = json.whisperOptions;
    if (typeof json.shellOptions === "object") cfg.shellOptions = json.shellOptions;

    return cfg;
  } catch (err) {
    console.log("[whisper-node] Failed to parse config. Ignoring.");
    return {};
  }
}

export default loadConfig;


