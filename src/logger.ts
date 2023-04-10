import { pino } from 'pino';
import * as dotenv from 'dotenv';
import { config } from './config.js';
dotenv.config();

const transport = pino.transport({
  target: 'pino-pretty',
  options: { destination: 1 },
});

const baseLogger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
  },
  transport,
);

export const logger = baseLogger.child({ name: config.get('bot_name') });
