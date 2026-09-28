import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly throwOnError?: boolean;
  readonly mode?: number;
}

export class RotatingFileSink {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly throwOnError: boolean;
  private readonly mode: number | undefined;
  private currentSize = 0;

  constructor(options: RotatingFileSinkOptions) {
    if (options.maxBytes < 1) {
      throw new Error(`maxBytes must be >= 1 (received ${options.maxBytes})`);
    }
    if (options.maxFiles < 0) {
      throw new Error(`maxFiles must be >= 0 (received ${options.maxFiles})`);
    }

    this.filePath = options.filePath;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles;
    this.throwOnError = options.throwOnError ?? false;
    this.mode = options.mode;

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.pruneOverflowBackups();
    this.currentSize = this.clampFile(this.filePath, this.readCurrentSize());
  }

  write(chunk: string | Buffer): void {
    const fullBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const buffer =
      fullBuffer.length > this.maxBytes
        ? fullBuffer.subarray(fullBuffer.length - this.maxBytes)
        : fullBuffer;
    if (buffer.length === 0) return;

    try {
      if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
        if (!this.rotate()) return;
      }

      if (this.mode === undefined) {
        fs.appendFileSync(this.filePath, buffer);
      } else {
        fs.appendFileSync(this.filePath, buffer, { mode: this.mode });
      }
      this.currentSize += buffer.length;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to write log chunk to ${this.filePath}`);
      }
    }
  }

  private clampFile(filePath: string, currentSize: number): number {
    if (currentSize <= this.maxBytes) return currentSize;
    try {
      const tail = Buffer.allocUnsafe(this.maxBytes);
      const handle = fs.openSync(filePath, "r");
      try {
        let read = 0;
        while (read < tail.length) {
          const next = fs.readSync(
            handle,
            tail,
            read,
            tail.length - read,
            currentSize - tail.length + read,
          );
          if (next === 0) throw new Error("Log file changed while clamping");
          read += next;
        }
      } finally {
        fs.closeSync(handle);
      }
      this.replaceFile(filePath, tail);
      return tail.length;
    } catch {
      if (this.throwOnError) throw new Error(`Failed to clamp log file ${filePath}`);
      return this.readCurrentSize(filePath);
    }
  }

  private replaceFile(filePath: string, contents: Buffer): void {
    const temporary = `${filePath}.penkra-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      const handle = fs.openSync(temporary, "wx", this.mode ?? 0o600);
      try {
        fs.writeFileSync(handle, contents);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temporary, filePath);
      const directory = fs.openSync(path.dirname(filePath), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private rotate(): boolean {
    try {
      if (this.maxFiles === 0) {
        this.replaceFile(this.filePath, Buffer.alloc(0));
        this.currentSize = 0;
        return true;
      }
      const oldest = this.withSuffix(this.maxFiles);
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }

      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        const source = this.withSuffix(index);
        const target = this.withSuffix(index + 1);
        if (fs.existsSync(source)) {
          fs.renameSync(source, target);
        }
      }

      if (fs.existsSync(this.filePath)) {
        const backup = this.withSuffix(1);
        const temporary = `${backup}.penkra-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
        try {
          fs.copyFileSync(this.filePath, temporary);
          fs.renameSync(temporary, backup);
        } finally {
          fs.rmSync(temporary, { force: true });
        }
        this.replaceFile(this.filePath, Buffer.alloc(0));
      }

      this.currentSize = 0;
      return true;
    } catch {
      this.currentSize = this.readCurrentSize();
      if (this.throwOnError) {
        throw new Error(`Failed to rotate log file ${this.filePath}`);
      }
      return false;
    }
  }

  private pruneOverflowBackups(): void {
    try {
      const dir = path.dirname(this.filePath);
      const baseName = path.basename(this.filePath);
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(`${baseName}.`) && entry.includes(".penkra-tmp-")) {
          fs.rmSync(path.join(dir, entry), { force: true });
          continue;
        }
        if (!entry.startsWith(`${baseName}.`)) continue;
        const suffix = Number(entry.slice(baseName.length + 1));
        if (!Number.isInteger(suffix)) continue;
        const backupPath = path.join(dir, entry);
        if (suffix > this.maxFiles) fs.rmSync(backupPath, { force: true });
        else if (suffix > 0) this.clampFile(backupPath, this.readCurrentSize(backupPath));
      }
    } catch {
      if (this.throwOnError) {
        throw new Error(`Failed to prune log backups for ${this.filePath}`);
      }
    }
  }

  private readCurrentSize(filePath = this.filePath): number {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return 0;
    }
  }

  private withSuffix(index: number): string {
    return `${this.filePath}.${index}`;
  }
}
