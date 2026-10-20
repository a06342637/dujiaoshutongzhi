import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

interface LoggerOptions {
  directory?: string;
  secrets?: string[];
  console?: boolean;
  maxBytes?: number;
}
const secretKey = /(?:token|password|authorization|secret|api[_-]?key)/i;
export class AppLogger {
  private readonly path: string | undefined;
  private readonly maxBytes: number;
  private memory: string[] = [];
  private fileWarning = false;
  constructor(private options: LoggerOptions = {}) {
    this.maxBytes = Math.max(2048, options.maxBytes ?? 256 * 1024);
    if (options.directory) {
      mkdirSync(options.directory, { recursive: true });
      this.path = join(options.directory, 'runtime.log');
    }
  }
  redact(value: string): string {
    let text = value;
    for (const secret of this.options.secrets ?? [])
      if (secret) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/\b(?:bot)?\d{5,}:[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
      .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+/g, '[REDACTED]')
      .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
      .replace(
        /((?:token|password|authorization|secret|api[_-]?key)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  }
  private write(level: string, message: string, context?: Record<string, unknown>) {
    let details = '';
    try {
      if (context)
        details = JSON.stringify(context, (key, value) =>
          secretKey.test(key)
            ? '[REDACTED]'
            : typeof value === 'string'
              ? this.redact(value)
              : value,
        );
    } catch {
      details = '[context unavailable]';
    }
    const time = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
    const clean = this.redact(`${time} ${level} ${message}${details ? ` ${details}` : ''}`).replace(
      /[\r\n\t\x00-\x1f\x7f]/g,
      ' ',
    );
    const limit = Math.min(1800, Math.floor(this.maxBytes / 6));
    const chars = Array.from(clean);
    const line = chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : clean;
    this.memory.push(line);
    if (this.memory.length > 500) this.memory.splice(0, this.memory.length - 500);
    if (this.options.console) {
      if (level === 'ERROR') console.error(line);
      else console.log(line);
    }
    if (!this.path) return;
    try {
      if (
        existsSync(this.path) &&
        statSync(this.path).size + Buffer.byteLength(line + '\n') > this.maxBytes
      ) {
        if (existsSync(this.path + '.1')) unlinkSync(this.path + '.1');
        renameSync(this.path, this.path + '.1');
      }
      appendFileSync(this.path, line + '\n', { encoding: 'utf8', mode: 0o600 });
      this.fileWarning = false;
    } catch {
      if (this.options.console && !this.fileWarning)
        console.error('应用日志暂时无法写入，已保留内存中的最近记录。');
      this.fileWarning = true;
    }
  }
  info(message: string, context?: Record<string, unknown>) {
    this.write('INFO', message, context);
  }
  warn(message: string, context?: Record<string, unknown>) {
    this.write('WARN', message, context);
  }
  error(message: string, context?: Record<string, unknown>) {
    this.write('ERROR', message, context);
  }
  private tail(path: string): string[] {
    if (!existsSync(path)) return [];
    const size = statSync(path).size,
      start = Math.max(0, size - this.maxBytes),
      buffer = Buffer.alloc(size - start),
      fd = openSync(path, 'r');
    let used: number;
    try {
      used = readSync(fd, buffer, 0, buffer.length, start);
    } finally {
      closeSync(fd);
    }
    const lines = buffer.subarray(0, used).toString('utf8').split(/\r?\n/);
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  }
  recent(limit = 50): string[] {
    const count = Math.max(0, Math.min(50, Math.trunc(limit)));
    if (!count) return [];
    if (this.path && !this.fileWarning) {
      try {
        const lines = [...this.tail(this.path + '.1'), ...this.tail(this.path)];
        if (lines.length) return lines.slice(-count).map((line) => this.redact(line));
      } catch {
        /* Memory fallback keeps the menu usable during disk errors. */
      }
    }
    return this.memory.slice(-count).map((line) => this.redact(line));
  }
}
