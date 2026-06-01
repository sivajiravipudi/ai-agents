/**
 * Logger utility — thin wrapper around console so log calls are
 * prefixed with a timestamp and severity level.
 */

const timestamp = () => new Date().toISOString();

export const logger = {
  info: (msg: string, ...args: unknown[]) =>
    console.info(`[${timestamp()}] [INFO]  ${msg}`, ...args),

  warn: (msg: string, ...args: unknown[]) =>
    console.warn(`[${timestamp()}] [WARN]  ${msg}`, ...args),

  error: (msg: string, ...args: unknown[]) =>
    console.error(`[${timestamp()}] [ERROR] ${msg}`, ...args),

  debug: (msg: string, ...args: unknown[]) =>
    console.debug(`[${timestamp()}] [DEBUG] ${msg}`, ...args),
};
