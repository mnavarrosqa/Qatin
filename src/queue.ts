import Queue from 'bull';
import Redis from 'ioredis';
import { logger } from './utils/logger';

const redisConfig = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false
};

// Create Bull queue
export const testQueue = new Queue('jira-qa-tests', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 50 // Keep last 50 failed jobs
  }
});

// Queue event listeners
testQueue.on('active', (job) => {
  logger.info(`Job ${job.id} started processing ticket ${job.data.ticketId}`);
});

testQueue.on('completed', (job, result) => {
  logger.info(`Job ${job.id} completed for ticket ${job.data.ticketId}`, { result });
});

testQueue.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed for ticket ${job?.data?.ticketId}:`, err);
});

testQueue.on('error', (error) => {
  logger.error('Queue error:', error);
});

logger.info('Queue initialized with Redis:', {
  host: redisConfig.host,
  port: redisConfig.port
});
