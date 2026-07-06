import pino from "pino";
import path from "node:path";

const destination = process.env.LOG_FILE
  || path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "daemon.log");

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: {
    target: "pino/file",
    options: {
      destination,
      mkdir: true
    }
  }
});
