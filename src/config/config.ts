import fs from "fs";
import path from "path";
import { IFlagTypes } from "../core/whisper";
import { IShellOptions } from "../infra/shell";
import { createLogger } from "../utils/logger";

const logger = createLogger('config');

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
      const normalized = path.normalize(fromEnv);
      // Enhanced path traversal protection
      if (normalized.includes('..') || !normalized.endsWith('.json')) {
        logger.warn("Invalid config path in WHISPER_NODE_CONFIG", { path: fromEnv, reason: "path traversal or invalid extension" });
        return null;
      }
      
      const p = path.resolve(normalized);
      // Additional security: ensure it's within reasonable bounds
      if (p.length > 1000) {
        logger.warn("Config path too long, ignoring", { pathLength: p.length });
        return null;
      }
      
      if (fs.existsSync(p)) return p;
    } catch (err) {
      logger.warn("Error processing config path", { path: fromEnv, error: err });
    }
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
    
    // Validate file size to prevent DoS
    if (raw.length > 100000) { // 100KB limit
      logger.warn("Config file too large, ignoring", { fileSize: raw.length, limit: 100000 });
      return {};
    }
    
    const json = JSON.parse(raw);
    const cfg: IWhisperConfig = {};

    // Validate and sanitize config values
    if (typeof json.modelName === "string" && json.modelName.length < 100) {
      cfg.modelName = json.modelName.trim();
    }
    
    if (typeof json.modelPath === "string" && json.modelPath.length < 1000) {
      // Basic path validation
      const normalized = path.normalize(json.modelPath);
      if (!normalized.includes('..')) {
        cfg.modelPath = normalized;
      } else {
        logger.warn("Invalid modelPath in config, ignoring", { modelPath: json.modelPath });
      }
    }
    
    if (typeof json.whisperOptions === "object" && json.whisperOptions !== null) {
      cfg.whisperOptions = json.whisperOptions;
    }
    
    if (typeof json.shellOptions === "object" && json.shellOptions !== null) {
      cfg.shellOptions = json.shellOptions;
    }

    return cfg;
  } catch (err) {
    logger.warn("Failed to parse config", { 
      configPath, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    });
    return {};
  }
}

export default loadConfig;


