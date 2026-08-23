import mongoose from 'mongoose';

import { env } from './env.js';
import { logger } from './logger.js';

// Reject queries that reference fields not present in the schema, instead of
// silently ignoring them.
mongoose.set('strictQuery', true);

const READY_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

let listenersAttached = false;

function attachConnectionListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    logger.info('MongoDB connected', { database: mongoose.connection.name });
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });
  mongoose.connection.on('error', (error) => {
    logger.error('MongoDB connection error', { message: error.message });
  });
}

export async function connectDatabase() {
  attachConnectionListeners();

  await mongoose.connect(env.MONGODB_URI, {
    // Fail a connection attempt in 10s rather than hanging on the default 30s.
    serverSelectionTimeoutMS: 10_000,
  });

  return mongoose.connection;
}

export async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) return;

  await mongoose.connection.close(false);
  logger.info('MongoDB connection closed');
}

export function getDatabaseStatus() {
  return READY_STATES[mongoose.connection.readyState] ?? 'unknown';
}
