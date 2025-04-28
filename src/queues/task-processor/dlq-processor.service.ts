// dlq-processor.service.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';

@Processor('task-processing-dlq')
export class DlqProcessorService extends WorkerHost {
  private readonly logger = new Logger(DlqProcessorService.name);

//   TODO: Manage DLQ
  async process(job: Job) {
    this.logger.warn(`Processing DLQ item ${job.id}:`, job.data); 
  }
}