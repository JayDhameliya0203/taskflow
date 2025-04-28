import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TaskProcessorService } from './task-processor.service';
import { TasksModule } from '../../modules/tasks/tasks.module';
import { DlqProcessorService } from './dlq-processor.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'task-processing',
    }),
    // Add DLQ
    BullModule.registerQueue({
      name: 'task-processing-dlq',
    }),
    TasksModule,
  ],
  
  providers: [TaskProcessorService, DlqProcessorService],
  exports: [TaskProcessorService],
})
export class TaskProcessorModule {}