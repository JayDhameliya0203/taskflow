import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async set<T>(key: string, value: T, ttlSeconds = 300): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await this.redis.set(key, serialized, 'EX', ttlSeconds);
      this.logger.debug(`Set cache key: ${key}`);
    } catch (err) {
      this.logger.error(`Error setting cache key "${key}":`, err);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const result = await this.redis.get(key);
      if (!result) {
        this.logger.debug(`Cache miss: ${key}`);
        return null;
      }
      this.logger.debug(`Cache hit: ${key}`);
      return JSON.parse(result);
    } catch (err) {
      this.logger.error(`Error getting cache key "${key}":`, err);
      return null;
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const result = await this.redis.del(key);
      this.logger.debug(`Deleted cache key: ${key}`);
      return result > 0;
    } catch (err) {
      this.logger.error(`Error deleting cache key "${key}":`, err);
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.redis.flushall();
      this.logger.warn(`Cache cleared`);
    } catch (err) {
      this.logger.error(`Error clearing cache:`, err);
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(key);
      return exists === 1;
    } catch (err) {
      this.logger.error(`Error checking cache key "${key}":`, err);
      return false;
    }
  }

  async deleteByPattern(pattern: string): Promise<void> {
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length) {
        await this.redis.del(...keys);
      }
      this.logger.debug(`Deleted cache keys matching pattern: ${pattern}`);
    } catch (err) {
      this.logger.error(`Error deleting cache keys by pattern "${pattern}":`, err);
    }
  }
}
