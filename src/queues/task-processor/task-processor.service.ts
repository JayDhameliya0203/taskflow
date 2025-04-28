import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { TasksService } from '../../modules/tasks/tasks.service';
import { TaskStatus } from '../../modules/tasks/enums/task-status.enum';

@Injectable()
@Processor('task-processing', {
  concurrency: 10,
  limiter: { max: 100, duration: 1000 },
})
export class TaskProcessorService extends WorkerHost {
  private readonly logger = new Logger(TaskProcessorService.name);
  private readonly MAX_RETRIES = 3;

  constructor(
    private readonly tasksService: TasksService,
    @InjectQueue('task-processing-dlq') private readonly dlqQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    const startTime = Date.now();
    this.logger.log(
      `-> Starting job ${job.id} [${job.name}] - Attempt ${job.attemptsMade + 1}/${this.MAX_RETRIES + 1}`,
    );

    try {
      let result;
      switch (job.name) {
        case 'task-status-update':
          this.logger.log(`-> Processing status update for task ${job.data.taskId}`);
          result = await this.handleStatusUpdate(job);
          break;
        case 'overdue-task-process':
          this.logger.log(`-> Processing overdue task ${job.data.taskId}`);
          result = await this.handleOverdueTask(job);
          break;
        default:
          this.logger.warn(`-> Unknown job type received: ${job.name}`);
          throw new Error(`Unknown job type: ${job.name}`);
      }

      this.logger.log(`-> Successfully processed job ${job.id} in ${Date.now() - startTime}ms`);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      if (job.attemptsMade < this.MAX_RETRIES) {
        this.logger.log(
          `-> Retrying job ${job.id} (Attempt ${job.attemptsMade + 2}/${this.MAX_RETRIES + 1})`,
        );
        throw err; // Triggers retry
      }

      // Final failure -> send to DLQ
      this.logger.error(`-> Max retries exceeded for job ${job.id}. Moving to DLQ.`);
      await this.sendToDlq(job, err);
    }
  }

  private async handleStatusUpdate(job: Job) {
    const { taskId, status } = job.data;

    if (!taskId || !status) {
      throw new Error('Missing required fields: taskId or status');
    }

    // Validate status
    if (!Object.values(TaskStatus).includes(status)) {
      this.logger.log(`-> Invalid status update attempt: ${status} for task ${taskId}`);
      throw new Error(`Invalid status: ${status}`);
    }

    this.logger.log(`-> Updating task ${taskId} to status ${status}`);
    const task = await this.tasksService.updateStatus(taskId, status);

    this.logger.log(`-> Successfully updated task ${taskId} to ${status}`);
    return {
      success: true,
      taskId: task.id,
      newStatus: task.status,
    };
  }

  private async handleOverdueTask(job: Job) {
    const { taskId } = job.data;

    if (!taskId) {
      throw new Error('Missing required field: taskId');
    }

    this.logger.log(`-> Marking task ${taskId} as IN_PROGRESS`);
    // Update task status to IN_PROGRESS
    const task = await this.tasksService.updateStatus(taskId, TaskStatus.IN_PROGRESS);

    this.logger.log(`-> Successfully marked task ${taskId} as IN_PROGRESS`);
    return {
      success: true,
      taskId: task.id,
      action: 'marked_In_Progreess',
    };
  }

  private async sendToDlq(job: Job, error: Error) {
    const dlqPayload = {
      original: job.data,
      error: error.message,
      meta: {
        attempts: job.attemptsMade,
        failedAt: new Date(),
        originalId: job.id,
        stack: error.stack,
      },
    };

    try {
      this.logger.warn(
        `-> Moving failed job ${job.id} to DLQ with payload: ${JSON.stringify(dlqPayload)}`,
      );

      await this.dlqQueue.add(`dlq-${job.name}`, dlqPayload, {
        removeOnComplete: true,
        attempts: 1,
      });

      this.logger.log(`-> Successfully moved job ${job.id} to DLQ`);
    } catch (dlqError) {
      this.logger.error(`-> Failed to moved job ${job.id} to DLQ`);
      throw dlqError;
    }
  }
}
