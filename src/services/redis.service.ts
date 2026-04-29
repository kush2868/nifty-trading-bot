import { createClient, RedisClientType } from 'redis';
import { config } from '../config';
import { logger } from '../utils/logger';

class RedisService {
  private client: RedisClientType | null = null;

  async connect(): Promise<void> {
    this.client = createClient({ url: config.redis.url }) as RedisClientType;

    this.client.on('error', (err) => logger.error({ err }, 'Redis error'));
    this.client.on('connect', () => logger.info('Redis connected'));
    this.client.on('reconnecting', () => logger.warn('Redis reconnecting'));

    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      logger.info('Redis disconnected');
    }
  }

  private getClient(): RedisClientType {
    if (!this.client) throw new Error('Redis not connected — call connect() first');
    return this.client;
  }

  async get(key: string): Promise<string | null> {
    return this.getClient().get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.getClient().setEx(key, ttlSeconds, value);
    } else {
      await this.getClient().set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.getClient().del(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async exists(key: string): Promise<boolean> {
    const count = await this.getClient().exists(key);
    return count > 0;
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.getClient().publish(channel, message);
  }
}

export const redisService = new RedisService();
