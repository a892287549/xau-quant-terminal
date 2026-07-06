import pino from "pino";
import path from "node:path";
import fs from "node:fs";

const destination = process.env.LOG_FILE
  || path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "daemon.log");
const maxBytes = Number(process.env.LOG_MAX_BYTES || 25 * 1024 * 1024);

function rotateLogIfNeeded(filePath) {
  try {
    if (!maxBytes || !fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size < maxBytes) return;
    const rotated = `${filePath}.1`;
    if (fs.existsSync(rotated)) fs.rmSync(rotated);
    fs.renameSync(filePath, rotated);
  } catch {
    // Logging must never prevent the trading service from starting.
  }
}

rotateLogIfNeeded(destination);

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
