/**
 * Custom error classes and error handling utilities for whisper-node
 */

export class WhisperNodeError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'WhisperNodeError';
  }
}

export class ValidationError extends WhisperNodeError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class SecurityError extends WhisperNodeError {
  constructor(message: string) {
    super(message, 'SECURITY_ERROR');
    this.name = 'SecurityError';
  }
}

export class FileNotFoundError extends WhisperNodeError {
  constructor(filePath: string) {
    super(`File not found: ${filePath}`, 'FILE_NOT_FOUND');
    this.name = 'FileNotFoundError';
  }
}

export class ModelNotFoundError extends WhisperNodeError {
  constructor(modelName: string) {
    super(`Model not found: ${modelName}. Run 'npx whisper-node download' to fetch models.`, 'MODEL_NOT_FOUND');
    this.name = 'ModelNotFoundError';
  }
}

/**
 * Safely execute an async operation with proper error handling
 * @param operation The async operation to execute
 * @param errorMessage Custom error message prefix
 * @returns Promise that resolves to the operation result or rejects with a WhisperNodeError
 */
export async function safeAsync<T>(
  operation: () => Promise<T>,
  errorMessage: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WhisperNodeError(`${errorMessage}: ${message}`);
  }
}

/**
 * Safely execute a synchronous operation with proper error handling
 * @param operation The sync operation to execute
 * @param errorMessage Custom error message prefix
 * @returns The operation result or throws a WhisperNodeError
 */
export function safeSync<T>(
  operation: () => T,
  errorMessage: string
): T {
  try {
    return operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WhisperNodeError(`${errorMessage}: ${message}`);
  }
}

/**
 * Check if an error is a known whisper-node error type
 * @param error The error to check
 * @returns True if it's a WhisperNodeError or subclass
 */
export function isWhisperNodeError(error: unknown): error is WhisperNodeError {
  return error instanceof WhisperNodeError;
}
