const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const { config } = require('../config/config');

const logDir = path.join(process.cwd(), 'logs');

const consoleFormat = format.combine(
  format.colorize(),
  format.timestamp({ format: 'HH:mm:ss' }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    const extra = Object.keys(meta).length
      ? '\n  ' + JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')
      : '';
    return `[${timestamp}] ${level}: ${message}${extra}`;
  })
);

const fileFormat = format.combine(
  format.timestamp(),
  format.errors({ stack: true }),
  format.json()
);

const logger = createLogger({
  level: config.logLevel,
  transports: [
    new transports.Console({ format: consoleFormat }),
    new transports.DailyRotateFile({
      format: fileFormat,
      dirname: logDir,
      filename: 'bot-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true,
    }),
    new transports.DailyRotateFile({
      level: 'error',
      format: fileFormat,
      dirname: logDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      zippedArchive: true,
    }),
  ]
});

module.exports = logger;
