import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcrypt';
import { UserResponseDto } from './dto/user-response.dto';
import { CacheService } from '@common/services/cache.service';

@Injectable()
export class UsersService {
  private readonly CACHE_TTL = 300;
  private readonly ALL_USERS_CACHE_KEY = 'users:all';

  constructor(
    @InjectRepository(User)
    private usersRepository: Repository<User>,
    private readonly cacheService: CacheService
  ) {}

  private toResponseDto(user: User): UserResponseDto {
    return new UserResponseDto({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  }

  private getUserCacheKey(id: string): string {
    return `user:id:${id}`;
  }

  private getUserByEmailCacheKey(email: string): string {
    return `user:email:${email}`;
  }

  async create(createUserDto: CreateUserDto): Promise<UserResponseDto> {
    const existingUser = await this.findByEmail(createUserDto.email);
    if (existingUser) {
      throw new ConflictException('Email already in use');
    }

    const hashedPassword = await bcrypt.hash(createUserDto.password, 10);
    const user = this.usersRepository.create({
      ...createUserDto,
      password: hashedPassword,
    });

    try {
      const savedUser = await this.usersRepository.save(user);
      await this.cacheService.delete(this.ALL_USERS_CACHE_KEY);
      return this.toResponseDto(savedUser);
    } catch (error) {
      throw new BadRequestException('Failed to create user');
    }
  }

  async findAll(): Promise<UserResponseDto[]> {
    const cacheKey = this.ALL_USERS_CACHE_KEY;
    
    const cached = await this.cacheService.get<UserResponseDto[]>(cacheKey);
    if (cached) return cached;

    const users = await this.usersRepository.find();
    const response = users.map(user => this.toResponseDto(user));

    await this.cacheService.set(cacheKey, response, this.CACHE_TTL);
    
    return response;
  }

  async findOne(id: string): Promise<UserResponseDto> {
    const cacheKey = this.getUserCacheKey(id);
    
    const cached = await this.cacheService.get<UserResponseDto>(cacheKey);
    if (cached) return cached;
    
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    
    const response = this.toResponseDto(user);
    await this.cacheService.set(cacheKey, response, this.CACHE_TTL);
  
    return response;
  }

  async findByEmail(email: string): Promise<User | null> {
    const cacheKey = this.getUserByEmailCacheKey(email);
    
    const cached = await this.cacheService.get<User>(cacheKey);
    if (cached) return cached;
    
    const user = await this.usersRepository.findOne({
      where: { email },
      select: ['id', 'email', 'password', 'role'],
    });
    
    if (user) {
      await this.cacheService.set(cacheKey, user, this.CACHE_TTL);
    }
    
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<UserResponseDto> {
    const user = await this.usersRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    // If email is being changed, verifies the new email isn't already in use
    if (updateUserDto.email && updateUserDto.email !== user.email) {
      const existingUser = await this.findByEmail(updateUserDto.email);
      if (existingUser) {
        throw new ConflictException('Email already in use');
      }
      // Invalidate cache for old email
      await this.cacheService.delete(this.getUserByEmailCacheKey(user.email));
    }

    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
    }

    this.usersRepository.merge(user, updateUserDto);

    try {
      const updatedUser = await this.usersRepository.save(user);
      const response = this.toResponseDto(updatedUser);
      
      // Update cache
      await this.cacheService.set(this.getUserCacheKey(id), response, this.CACHE_TTL);
      if (updateUserDto.email) {
        await this.cacheService.set(
          this.getUserByEmailCacheKey(updatedUser.email), 
          updatedUser, 
          this.CACHE_TTL
        );
      }
      
      await this.cacheService.delete(this.ALL_USERS_CACHE_KEY);
      return response;
    } catch (error) {
      throw new BadRequestException('Failed to update user');
    }
  }

  async remove(id: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id } });
        if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    try {
      const email = user.email;
      await this.usersRepository.remove(user);
      await Promise.all([
        this.cacheService.delete(this.getUserCacheKey(id)),
        this.cacheService.delete(this.getUserByEmailCacheKey(email)),
        this.cacheService.delete(this.ALL_USERS_CACHE_KEY),
      ]);
    } catch (error) {
      throw new BadRequestException('Failed to delete user');
    }
  }
}