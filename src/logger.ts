import { pino } from 'pino';
import * as dotenv from 'dotenv'
dotenv.config()

const transport = pino.transport({
  target: 'pino-pretty',
  options: { destination: 1 },
});

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
  },
  transport,
);
