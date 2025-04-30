// src/common/cache/cache.module.ts
import { Module, Global } from '@nestjs/common';
import { RedisProvider } from './providers/redis.provider';
import { CacheService } from './services/cache.service';

@Global() 
@Module({
  providers: [RedisProvider, CacheService],
  exports: [RedisProvider, CacheService],
})
export class CommonModule {}