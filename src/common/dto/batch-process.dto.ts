import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsEnum, IsString } from 'class-validator';

export class BatchProcessTasksDto {
  @ApiProperty({ example: ['123e4567-e89b-12d3-a456-426614174000', '123e4567-e89b-12d3-a456-426614174001' ] })
  @IsArray()
  @IsString({ each: true })
  tasks: string[];

  @ApiProperty({ example: 'complete'})
  @IsEnum(['complete', 'delete'])
  action: 'complete' | 'delete';
}
