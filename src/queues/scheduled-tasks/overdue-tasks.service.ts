import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Task } from '../../modules/tasks/entities/task.entity';
import { TaskStatus } from '../../modules/tasks/enums/task-status.enum';

@Injectable()
export class OverdueTasksService {
  private readonly logger = new Logger(OverdueTasksService.name);
  private readonly BATCH_SIZE = 100;

  constructor(
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkOverdueTasks() {
    const startTime = Date.now();
    this.logger.debug('-> Starting overdue tasks check...');
    const now = new Date();

    try {
      // Log database query start
      this.logger.debug('-> Querying database for overdue tasks count...');
      const total = await this.tasksRepository.count({
        where: {
          dueDate: LessThan(now),
          status: TaskStatus.PENDING,
        },
      });

      if (total === 0) {
        this.logger.debug('-> No overdue tasks found');
        return;
      }

      this.logger.log(`-> Found ${total} overdue tasks. Processing in batches of ${this.BATCH_SIZE}...`);

      // Process in batches
      const totalBatches = Math.ceil(total / this.BATCH_SIZE);
      for (let i = 0; i < total; i += this.BATCH_SIZE) {
        const batchStartTime = Date.now();
        const batchNumber = i / this.BATCH_SIZE + 1;
        
        this.logger.debug(`-> Processing batch ${batchNumber}/${totalBatches}...`);
        
        const tasks = await this.tasksRepository.find({
          where: {
            dueDate: LessThan(now),
            status: TaskStatus.PENDING,
          },
          take: this.BATCH_SIZE,
          skip: i,
        });

        // Log batch details
        this.logger.debug(`-> Batch ${batchNumber} contains ${tasks.length} tasks`);

        // Add jobs to queue
        const jobAddStartTime = Date.now();
        await this.taskQueue.addBulk(
          tasks.map(task => ({
            name: 'overdue-task-process',
            data: { taskId: task.id },
            opts: {
              attempts: 3,
              backoff: { 
                type: 'exponential', 
                delay: 1000 
              },
              removeOnComplete: true,
            },
          }))
        );

        this.logger.debug(
          `-> Added batch ${batchNumber} to queue in ${Date.now() - jobAddStartTime}ms`
        );
        this.logger.debug(
          `-> Batch ${batchNumber} processed in ${Date.now() - batchStartTime}ms`
        );
      }

      this.logger.log(
        `-> Successfully processed ${total} overdue tasks in ${Date.now() - startTime}ms`
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to check overdue tasks';
      this.logger.error(`-> Error in overdue tasks check: ${errorMessage}`);
      throw error;
    }
  }
}