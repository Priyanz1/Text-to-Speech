import { env, isProduction } from './env.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[env.LOG_LEVEL];

/**
 * Deliberately small. In production it writes one JSON object per line, which
 * is what hosted log collectors expect. In development it writes something a
 * human can read.
 *
 * If we later need child loggers, sampling or log shipping, swap this module
 * for pino - nothing else in the codebase has to change.
 */
function write(level, message, meta) {
  if (LEVELS[level] > activeLevel) return;

  const time = new Date().toISOString();
  const stream = level === 'error' ? process.stderr : process.stdout;

  if (isProduction) {
    stream.write(`${JSON.stringify({ time, level, message, ...meta })}\n`);
    return;
  }

  const details = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  stream.write(`${time}  ${level.toUpperCase().padEnd(5)} ${message}${details}\n`);
}

export const logger = {
  error: (message, meta) => write('error', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  info: (message, meta) => write('info', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};
