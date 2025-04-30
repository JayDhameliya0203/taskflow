import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Task } from './entities/task.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TaskStatus } from './enums/task-status.enum';
import { TaskResponseDto } from './dto/task-response.dto';
import { TaskPriority } from './enums/task-priority.enum';
import { LoggedInUser } from '../../types/loggedIn-user.interface';
import { TaskFilterDto } from './dto/task-filter.dto';
import { CacheService } from '@common/services/cache.service';

@Injectable()
export class TasksService {
  private readonly CACHE_TTL = 300; // 5 minutes in seconds
  private readonly TASKS_LIST_CACHE_PREFIX = 'tasks:list:';
  private readonly TASK_STATS_CACHE_KEY = 'tasks:stats';

  constructor(
    @InjectRepository(Task)
    private tasksRepository: Repository<Task>,
    @InjectQueue('task-processing')
    private taskQueue: Queue,
    private dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  private toResponseDto(task: Task): TaskResponseDto {
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      userId: task.user?.id || task.userId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private getTaskCacheKey(id: string): string {
    return `task:id:${id}`;
  }

  private getTasksListCacheKey(filterDto: TaskFilterDto): string {
    const { page = 1, limit = 10, status, priority } = filterDto;
    return `${this.TASKS_LIST_CACHE_PREFIX}${status || 'all'}:${priority || 'all'}:${page}:${limit}`;
  }

  private async findTaskEntity(id: string): Promise<Task> {
    const cacheKey = this.getTaskCacheKey(id);

    const cached = await this.cacheService.get<Task>(cacheKey);
    if (cached) return cached;

    const task = await this.tasksRepository.findOne({
      where: { id },
      relations: ['user'],
    });

    if (!task) {
      throw new NotFoundException(`Task with ID ${id} not found`);
    }

    await this.cacheService.set(cacheKey, task, this.CACHE_TTL);

    return task;
  }

  async create(createTaskDto: CreateTaskDto): Promise<TaskResponseDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = this.tasksRepository.create(createTaskDto);
      const savedTask = await queryRunner.manager.save(task);

      await this.taskQueue.add('task-status-update', {
        taskId: savedTask.id,
        status: savedTask.status,
      });

      // Invalidate all tasks lists cache (since we added a new task)
      await this.cacheService.deleteByPattern(`${this.TASKS_LIST_CACHE_PREFIX}*`);
      // Invalidate stats cache
      await this.cacheService.delete(this.TASK_STATS_CACHE_KEY);

      await queryRunner.commitTransaction();
      return this.toResponseDto(savedTask);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to create task');
    } finally {
      await queryRunner.release();
    }
  }

  async findAll(params: TaskFilterDto): Promise<{ data: TaskResponseDto[]; total: number }> {
    const cacheKey = this.getTasksListCacheKey(params);

    const cached = await this.cacheService.get<{ data: TaskResponseDto[]; total: number }>(
      cacheKey,
    );
    if (cached) return cached;

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

    const result = {
      data: tasks.map(task => this.toResponseDto(task)),
      total,
    };

    // Cache the result
    await this.cacheService.set(cacheKey, result, this.CACHE_TTL);

    return result;
  }

  async findOne(id: string): Promise<TaskResponseDto> {
    const task = await this.findTaskEntity(id);
    return this.toResponseDto(task);
  }

  async update(id: string, updateTaskDto: UpdateTaskDto): Promise<TaskResponseDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = await this.findTaskEntity(id);
      if (!task) {
        throw new NotFoundException(`Task with ID ${id} not found`);
      }

      const originalStatus = task.status;

      Object.assign(task, updateTaskDto);
      const updatedTask = await queryRunner.manager.save(task);

      if (originalStatus !== updatedTask.status) {
        await this.taskQueue.add('task-status-update', {
          taskId: updatedTask.id,
          status: updatedTask.status,
        });
      }

      // Update/invalidate cache
      await Promise.all([
        this.cacheService.set(this.getTaskCacheKey(id), updatedTask, this.CACHE_TTL),
        this.cacheService.deleteByPattern(`${this.TASKS_LIST_CACHE_PREFIX}*`),
        this.cacheService.delete(this.TASK_STATS_CACHE_KEY),
      ]);

      await queryRunner.commitTransaction();
      return this.toResponseDto(updatedTask);
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
      const task = await this.findTaskEntity(id);
      if (!task) {
        throw new NotFoundException(`Task with ID ${id} not found`);
      }
      await queryRunner.manager.remove(task);

      // Invalidate cache
      await Promise.all([
        this.cacheService.delete(this.getTaskCacheKey(id)),
        this.cacheService.deleteByPattern(`${this.TASKS_LIST_CACHE_PREFIX}*`),
        this.cacheService.delete(this.TASK_STATS_CACHE_KEY),
      ]);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to delete task');
    } finally {
      await queryRunner.release();
    }
  }

  async updateStatus(id: string, status: string): Promise<TaskResponseDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const task = await this.findTaskEntity(id);
      if (!task) {
        throw new NotFoundException(`Task with ID ${id} not found`);
      }

      task.status = status as TaskStatus;
      const updatedTask = await queryRunner.manager.save(task);
      await queryRunner.commitTransaction();
      return this.toResponseDto(updatedTask);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw new BadRequestException('Failed to update task status');
    } finally {
      await queryRunner.release();
    }
  }

  async getStats() {
    const cacheKey = this.TASK_STATS_CACHE_KEY;

    // Try cache first
    const cached = await this.cacheService.get<any>(cacheKey);
    if (cached) return cached;

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
    const result = stats[0];

    await this.cacheService.set(cacheKey, result, this.CACHE_TTL);

    return result;
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

          if (user.role !== 'admin' && task.userId !== user.id) {
            results.push({ taskId, success: false, error: 'Unauthorized access to task' });
            continue;
          }

          let result;
          switch (action) {
            case 'complete':
              task.status = TaskStatus.COMPLETED;
              const savedTask = await queryRunner.manager.save(task);
              result = this.toResponseDto(savedTask);
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
