import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, ForbiddenException, BadRequestException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { TaskStatus } from './enums/task-status.enum';
import { TaskPriority } from './enums/task-priority.enum';
import { RateLimitGuard } from '../../common/guards/rate-limit.guard';
import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { GetTasksFilterDto } from '../../common/dto/task-filter.dto';
import { Public } from '@common/decorators/public.decorator';
import { JwtAuthGuard } from '@modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@modules/auth/decorators/current-user.decorator';
import { LoggedInUser } from '../../types/loggedIn-user.interface';
import { BatchProcessTasksDto } from '@common/dto/batch-process.dto';

@ApiTags('tasks')
@Controller('tasks')
@UseGuards(JwtAuthGuard, RateLimitGuard)
@RateLimit({ limit: 100, windowMs: 60000 })
@ApiBearerAuth()
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new task' })
  create(@Body() createTaskDto: CreateTaskDto, @CurrentUser() user: LoggedInUser) {

  // Only admin can assign tasks to others
  if (user.role !== 'admin' && createTaskDto.userId !== user.id) {
    throw new ForbiddenException('You can only create tasks for yourself');
  }
    return this.tasksService.create(createTaskDto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Find all tasks with optional filtering' })
  @ApiQuery({ name: 'status', required: false, enum: TaskStatus })
  @ApiQuery({ name: 'priority', required: false, enum: TaskPriority })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async findAll(
    @Query() filterDto: GetTasksFilterDto,
  ) {
    return this.tasksService.findAll(filterDto);
  }
  
  @Public()
  @Get('stats')
  @ApiOperation({ summary: 'Get task statistics' })
  async getStats() {
    return this.tasksService.getStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Find a task by ID' })
  async findOne(@Param('id') id: string, @CurrentUser() user: LoggedInUser ) {
    const task = await this.tasksService.findOne(id);
    if (task.userId !== user.id) {
      throw new ForbiddenException('Unauthorized access to task');
    }

    return task;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a task' })
  async update(
    @Param('id') id: string,
    @Body() updateTaskDto: UpdateTaskDto,
    @CurrentUser() user: LoggedInUser,
  ) {
    const task = await this.tasksService.findOne(id);
    if (task.userId !== user.id) {
      throw new ForbiddenException('Unauthorized access to task');
    }

    if (Object.keys(updateTaskDto).length === 0) {
      throw new BadRequestException('At least one field must be provided to update');
    }

    return this.tasksService.update(id, updateTaskDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a task' })
  async remove(@Param('id') id: string, @CurrentUser() user: LoggedInUser) {
  const task = await this.tasksService.findOne(id);

  // Allow admin to delete any task and user can delete assigned task
  if (user.role !== 'admin' && task.userId !== user.id) {
    throw new ForbiddenException('Unauthorized access to task');
  }
    await this.tasksService.remove(id);
    return { message: 'Task deleted successfully' };
  }

  @Post('batch')
  @ApiOperation({ summary: 'Batch process multiple tasks' })
  async batchProcess(
    @Body() operations: BatchProcessTasksDto,
    @CurrentUser() user: LoggedInUser,
  ) {
    return this.tasksService.batchProcess(operations, user);
  }
  
} 