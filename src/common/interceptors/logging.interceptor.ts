import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { LoggedInUser } from '../../types/loggedIn-user.interface';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);
  private readonly sensitiveFields = [
    'token',
    'access_token',
    'refresh_token',
    'authorization',
  ];

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request & { user?: LoggedInUser }>();
    const response = httpContext.getResponse<Response>();

    const requestId = uuidv4();
    const startTime = Date.now();
    const { method, originalUrl, ip = 'unknown', headers } = request;
    const userAgent = headers['user-agent'] || '';
    const userId = request.user?.id || 'anonymous';

    // Sanitize and log request
    this.logRequest({
      requestId,
      method,
      url: originalUrl,
      ip,
      userAgent,
      userId,
      headers: this.sanitizeHeaders(headers),
      body: this.sanitizeBody(request.body),
      query: request.query,
      params: request.params,
    });

    return next.handle().pipe(
      tap({
        next: (body) => {
          this.logResponse({
            requestId,
            method,
            url: originalUrl,
            statusCode: response.statusCode,
            responseTime: Date.now() - startTime,
            userId,
            body: this.sanitizeBody(body),
          });
        },
        error: (error) => {
          this.logError({
            requestId,
            method,
            url: originalUrl,
            statusCode: error.status || 500,
            responseTime: Date.now() - startTime,
            userId,
            error: {
              name: error.name,
              message: error.message,
              stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
            },
          });
        },
      }),
    );
  }

  private logRequest(data: {
    requestId: string;
    method: string;
    url: string;
    ip: string;
    userAgent: string;
    userId: string;
    headers: Record<string, any>;
    body: any;
    query: any;
    params: any;
  }) {
    this.logger.log({
      message: `Incoming Request - ${data.method} ${data.url}`,
      context: 'Request',
      ...data,
    });
  }

  private logResponse(data: {
    requestId: string;
    method: string;
    url: string;
    statusCode: number;
    responseTime: number;
    userId: string;
    body?: any;
  }) {
    this.logger.log({
      message: `Outgoing Response - ${data.method} ${data.url} ${data.statusCode}`,
      context: 'Response',
      ...data,
      responseTime: `${data.responseTime}ms`,
    });
  }

  private logError(data: {
    requestId: string;
    method: string;
    url: string;
    statusCode: number;
    responseTime: number;
    userId: string;
    error: {
      name: string;
      message: string;
      stack?: string;
    };
  }) {
    this.logger.error({
      message: `Request Error - ${data.method} ${data.url} ${data.statusCode}`,
      context: 'Error',
      ...data,
      responseTime: `${data.responseTime}ms`,
    });
  }

  private sanitizeHeaders(headers: Record<string, any>): Record<string, any> {
    const sanitized = { ...headers };
    this.sensitiveFields.forEach((field) => {
      if (sanitized[field]) sanitized[field] = '*****';
      if (sanitized[field.toLowerCase()]) sanitized[field.toLowerCase()] = '*****';
    });
    return sanitized;
  }

  private sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') return body;
    const sanitized = { ...body };
    this.sensitiveFields.forEach((field) => {
      if (sanitized[field]) sanitized[field] = '*****';
    });
    return sanitized;
  }
}