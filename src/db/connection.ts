import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from '../utils/logger';

let isConnected = false;

export async function connectMongo(): Promise<void> {
  if (isConnected) return;

  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — attempting reconnect');
    isConnected = false;
  });
  mongoose.connection.on('error', (err) => logger.error({ err }, 'MongoDB error'));

  await mongoose.connect(config.mongo.uri, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  isConnected = true;
}

export async function disconnectMongo(): Promise<void> {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  logger.info('MongoDB disconnected cleanly');
}
