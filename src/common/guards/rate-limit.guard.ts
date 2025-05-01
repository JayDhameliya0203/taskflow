import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitOptions, RATE_LIMIT_KEY } from '../decorators/rate-limit.decorator';

interface RequestLog {
  timestamps: number[];
}

// In-memory storage: Map<key, timestamps[]>
const requestLogs: Map<string, RequestLog> = new Map();

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const ip = req.ip;
    const handler = context.getHandler();
    const classRef = context.getClass();

    const rateLimitOptions: RateLimitOptions = this.reflector.get<RateLimitOptions>(
      RATE_LIMIT_KEY,
      handler,
    ) ||
      this.reflector.get<RateLimitOptions>(RATE_LIMIT_KEY, classRef) || {
        limit: 100,
        windowMs: 60000,
      };

    const key = `${ip}:${handler.name}`;
    const now = Date.now();
    const windowStart = now - rateLimitOptions.windowMs;

    const log = requestLogs.get(key) || { timestamps: [] };
    log.timestamps = log.timestamps.filter(ts => ts > windowStart);

    if (log.timestamps.length >= rateLimitOptions.limit) {
      const retryAfter = (log.timestamps[0] + rateLimitOptions.windowMs - now) / 1000;

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests, please try again later.',
          retryAfterSeconds: Math.ceil(retryAfter),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    log.timestamps.push(now);
    requestLogs.set(key, log);

    return true;
  }
}
