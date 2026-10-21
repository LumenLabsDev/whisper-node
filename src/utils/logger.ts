/**
 * Structured logging utilities for whisper-node
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: any;
}

/**
 * JSON-encode log data without throwing: errors keep their message and code,
 * circular references and BigInts are replaced, functions are named.
 */
function serialize(data: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(data, (_key, value) => {
      if (value instanceof Error) {
        const { code } = value as NodeJS.ErrnoException;
        return { name: value.name, message: value.message, ...(code !== undefined ? { code } : {}) };
      }
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }) ?? String(data);
  } catch {
    return String(data);
  }
}

export class Logger {
  private module: string;
  private logLevel: LogLevel;

  constructor(module: string, logLevel: LogLevel = LogLevel.INFO) {
    this.module = module;
    this.logLevel = logLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    return level <= this.logLevel;
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const levelName = LogLevel[level];
    const prefix = `[${timestamp}] [${levelName}] [${this.module}]`;
    
    if (data !== undefined) {
      return `${prefix} ${message} ${serialize(data)}`;
    }
    return `${prefix} ${message}`;
  }

  error(message: string, data?: any): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage(LogLevel.ERROR, message, data));
    }
  }

  warn(message: string, data?: any): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(LogLevel.WARN, message, data));
    }
  }

  info(message: string, data?: any): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log(this.formatMessage(LogLevel.INFO, message, data));
    }
  }

  debug(message: string, data?: any): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log(this.formatMessage(LogLevel.DEBUG, message, data));
    }
  }

  setLevel(level: LogLevel): void {
    this.logLevel = level;
  }

  getLevel(): LogLevel {
    return this.logLevel;
  }
}

/**
 * Create a logger instance for a specific module
 */
export function createLogger(module: string, level?: LogLevel): Logger {
  const logLevel = level ?? getLogLevelFromEnv();
  return new Logger(module, logLevel);
}

/**
 * Get log level from environment variable
 */
function getLogLevelFromEnv(): LogLevel {
  const envLevel = process.env.WHISPER_NODE_LOG_LEVEL?.toUpperCase();
  switch (envLevel) {
    case 'ERROR':
      return LogLevel.ERROR;
    case 'WARN':
      return LogLevel.WARN;
    case 'INFO':
      return LogLevel.INFO;
    case 'DEBUG':
      return LogLevel.DEBUG;
    default:
      return LogLevel.INFO;
  }
}

/**
 * Default logger instance for general use
 */
export const defaultLogger = createLogger('whisper-node');
