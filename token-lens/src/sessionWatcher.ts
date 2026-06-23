import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import * as chokidar from 'chokidar';
import { SessionParser, ParsedEvent } from './parser';

// ─────────────────────────────────────────────────────────────
// SessionWatcher — watches ALL JSONL files simultaneously
// Events are tagged with sessionCwd so the extension can route
// them to the right tab (project vs global).
// ─────────────────────────────────────────────────────────────

export declare interface SessionWatcher {
  on(event: 'event',          listener: (e: ParsedEvent) => void): this;
  on(event: 'sessionChanged', listener: (filePath: string, sessionCwd?: string) => void): this;
  on(event: 'error',          listener: (err: Error) => void): this;
}

export class SessionWatcher extends EventEmitter {
  private watcher?: chokidar.FSWatcher;
  private parsers:       Map<string, SessionParser> = new Map();
  private filePositions: Map<string, number>        = new Map();
  private knownToolNames: string[] = [];
  private mostRecentFile?: string;          // for `sessionChanged` display
  private sessionCheckInterval?: ReturnType<typeof setInterval>;
  private claudeProjectsDir: string;

  constructor() {
    super();
    this.claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
  }

  start() {
    if (!fs.existsSync(this.claudeProjectsDir)) {
      this.emit('error', new Error(`Claude projects dir not found: ${this.claudeProjectsDir}`));
      return;
    }

    // ignoreInitial: false  →  'add' fires for every existing file on startup,
    // so we parse historical data immediately
    this.watcher = chokidar.watch(
      path.join(this.claudeProjectsDir, '**', '*.jsonl'),
      { persistent: true, ignoreInitial: false, usePolling: false }
    );

    this.watcher.on('add',    (fp) => this.handleFile(fp));
    this.watcher.on('change', (fp) => this.handleFile(fp));
    this.watcher.on('error',  (err) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    // Re-check every 3 s in case a brand-new file appears between chokidar events
    this.sessionCheckInterval = setInterval(() => this.findNewest(), 3000);
  }

  stop() {
    this.watcher?.close();
    this.watcher = undefined;
    clearInterval(this.sessionCheckInterval as unknown as number);
    this.parsers.clear();
    this.filePositions.clear();
  }

  /** Tell every parser which tool names map to skills/agents. */
  setKnownToolNames(names: string[]) {
    this.knownToolNames = names;
    for (const p of this.parsers.values()) p.setKnownToolNames(names);
  }

  getActiveSession(): string | undefined { return this.mostRecentFile; }

  // ─── Private ──────────────────────────────────────────────

  private handleFile(filePath: string) {
    this.readNewLines(filePath);

    // Track most-recently-modified file for sessionChanged display
    try {
      const mtime = fs.statSync(filePath).mtimeMs;
      const currentBest = this.mostRecentFile
        ? fs.statSync(this.mostRecentFile).mtimeMs
        : 0;
      if (mtime >= currentBest) {
        const parser = this.parsers.get(filePath);
        const cwd = parser?.getCwd();
        if (filePath !== this.mostRecentFile) {
          this.mostRecentFile = filePath;
          this.emit('sessionChanged', filePath, cwd);
        }
      }
    } catch { /* ignore stat errors */ }
  }

  private findNewest() {
    const newest = findMostRecentJsonl(this.claudeProjectsDir);
    if (newest && newest !== this.mostRecentFile) {
      this.handleFile(newest);
    }
  }

  /** Read only new bytes from a file and parse each new line. */
  private readNewLines(filePath: string) {
    // Get or create a parser for this file
    let parser = this.parsers.get(filePath);
    if (!parser) {
      parser = new SessionParser();
      parser.setKnownToolNames(this.knownToolNames);
      this.parsers.set(filePath, parser);
      this.filePositions.set(filePath, 0);
    }

    let fd: number;
    try { fd = fs.openSync(filePath, 'r'); } catch { return; }

    try {
      const position = this.filePositions.get(filePath) ?? 0;
      const { size }  = fs.fstatSync(fd);
      if (size <= position) return;

      const buf = Buffer.alloc(size - position);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
      if (bytesRead === 0) return;

      this.filePositions.set(filePath, position + bytesRead);

      for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
        for (const ev of parser.parseLine(line)) {
          this.emit('event', ev);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────

function findMostRecentJsonl(dir: string): string | undefined {
  let best: string | undefined;
  let bestTime = 0;

  function walk(d: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try {
        const t = fs.statSync(full).mtimeMs;
        if (t > bestTime) { bestTime = t; best = full; }
      } catch { /* ignore */ }
    }
  }

  walk(dir);
  return best;
}
