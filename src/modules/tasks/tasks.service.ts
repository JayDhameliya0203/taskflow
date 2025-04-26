import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Task } from './entities/task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TaskStatus } from './enums/task-status.enum';
import { GetTasksFilterDto } from '../../common/dto/task-filter.dto';
import { TaskPriority } from './enums/task-priority.enum';
import { LoggedInUser } from '../../types/loggedIn-user.interface';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    private dataSource: DataSource,
  ) {}

  async create(createTaskDto: CreateTaskDto): Promise<Task> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = this.tasksRepository.create(createTaskDto);
      const savedTask = await queryRunner.manager.save(task);

      // Add to queue with proper error handling
      await this.taskQueue.add('task-status-update', {
        taskId: savedTask.id,
        status: savedTask.status,
      });

      await queryRunner.commitTransaction();
      return savedTask;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to create task');
    } finally {
      await queryRunner.release();
    }
  }

  async findAll(params: GetTasksFilterDto): Promise<{ data: Task[]; total: number }> {
    const { page = 1, limit = 10, status, priority } = params;
    const skip = (page - 1) * limit;
  
    const where: { status?: TaskStatus; priority?: TaskPriority } = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
  
    const [tasks, total] = await this.tasksRepository.findAndCount({
      where,
      relations: ['user'],
      skip,
      take: limit,
      order: {
        createdAt: 'DESC',
      },
    });
  
    return { data: tasks, total };
  }
  
  async findOne(id: string): Promise<Task> {
    const task = await this.tasksRepository.findOne({
      where: { id },
      relations: ['user'],
    });

    if (!task) {
      throw new NotFoundException(`Task with ID ${id} not found`);
    }

    return task;
  }

  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<Task> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = await this.findOne(id);
      const originalStatus = task.status;

      Object.assign(task, updateTaskDto);
      const updatedTask = await queryRunner.manager.save(task);

      if (originalStatus !== updatedTask.status) {
        await this.taskQueue.add('task-status-update', {
          taskId: updatedTask.id,
          status: updatedTask.status,
        });
      }

      await queryRunner.commitTransaction();
      return updatedTask;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to update task');
    } finally {
      await queryRunner.release();
    }
  }

  async remove(id: string): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = await this.findOne(id);
      await queryRunner.manager.remove(task);
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to delete task');
    } finally {
      await queryRunner.release();
    }
  }

  async updateStatus(id: string, status: string): Promise<Task> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = await this.findOne(id);
      task.status = status as TaskStatus;
      const updatedTask = await queryRunner.manager.save(task);
      await queryRunner.commitTransaction();
      return updatedTask;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to update task status');
    } finally {
      await queryRunner.release();
    }
  }

  async getStats() {
    const query = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) as inProgress,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN priority = 'HIGH' THEN 1 ELSE 0 END) as highPriority
      FROM tasks
    `;

    const stats = await this.tasksRepository.query(query);
    return stats[0];
  }

  async batchProcess(operations: { tasks: string[]; action: string }, user: LoggedInUser) {
    const { tasks: taskIds, action } = operations;
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
  
    try {
      const results = [];
  
      for (const taskId of taskIds) {
        try {
          const task = await this.tasksRepository.findOne({
            where: { id: taskId },
          });
  
          if (!task) {
            results.push({ taskId, success: false, error: 'Task not found' });
            continue;
          }
  
          // Check if user is not admin and trying to modify other's task
          if (user.role !== 'admin' && task.userId !== user.id) {
            results.push({ taskId, success: false, error: 'Unauthorized access to task' });
            continue;
          }
  
          let result;
          switch (action) {
            case 'complete':
              task.status = TaskStatus.COMPLETED;
              result = await queryRunner.manager.save(task);
              break;
            case 'delete':
              await queryRunner.manager.remove(task);
              result = { message: 'Task deleted' };
              break;
            default:
              throw new BadRequestException(`Unknown action: ${action}`);
          }
  
          results.push({ taskId, success: true, result });
        } catch (error) {
          results.push({
            taskId,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
  
      await queryRunner.commitTransaction();
      return results;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to process batch operations');
    } finally {
      await queryRunner.release();
    }
  }
  
}
