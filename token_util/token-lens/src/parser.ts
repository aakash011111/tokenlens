import * as fs from 'fs';
import * as path from 'path';
import { calcCacheHitCost, calcInputCost, calcOutputCost, calcCompactionSaving, fmtTokens, tokToMTok, getPricing } from './pricer';

// ─────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────

export type EventType =
  | 'CACHE_HIT'
  | 'COMPACTION_FIRED'
  | 'CLAUDE_MD_LOAD'
  | 'LARGE_FILE_READ'
  | 'REPEATED_FILE_READ'
  | 'PLUGIN_FIRED'
  | 'SKILL_AGENT_USED'
  | 'TURN_COMPLETED'  // fires on every assistant message — keeps cost counter live
  | 'VAGUE_PROMPT';

export interface ParsedEvent {
  type: EventType;
  timestamp: number;
  tokens: number;
  savedTokens: number;
  cost: number;
  savedCost: number;
  normalCost: number;
  outputCost?: number;   // <-- ADD THIS LINE
  label: string;
  detail: string;
  advice?: string;
  filePath?: string;
  featureName?: string;
  model: string;
  sessionCwd?: string;  // set by watcher — used to route event to project vs global tab
}

// ─────────────────────────────────────────────────────────────
// Raw JSONL entry shapes (Claude Code session format)
// ─────────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawMessage {
  id?: string;
  role?: string;
  type?: string;
  model?: string;
  content?: string | ContentBlock[];
  usage?: TokenUsage;
  stop_reason?: string;
}

interface RawEntry {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: RawMessage;
  // Some system entries have top-level content
  content?: string | ContentBlock[];
}

// ─────────────────────────────────────────────────────────────
// Parser (stateful — one instance per active session)
// ─────────────────────────────────────────────────────────────

export class SessionParser {
  private model: string = 'claude-sonnet-4-6';
  private cwd?: string;
  private claudeMdLoaded = false;

  // tool_use_id → {name, input} — correlates assistant tool calls with user tool results
  private pendingToolCalls: Map<string, { name: string; input: Record<string, unknown> }> = new Map();

  // file path → read count
  private fileReadCounts: Map<string, number> = new Map();

  private lastUserPrompt: string = '';
  private lastPromptAnalyzed: boolean = false;
  private hadFileReadThisTurn: boolean = false;

  // per-session turn/cache tracking for advice
  private turnCount = 0;
  private lastCacheHitTurn = -1;

  // known skill/agent tool names (injected by extension from scanner)
  private knownToolNames: Set<string> = new Set();

  setKnownToolNames(names: string[]) {
    this.knownToolNames = new Set(names.map(n => n.toLowerCase()));
  }

  reset() {
    this.model = 'claude-sonnet-4-6';
    this.cwd = undefined;
    this.claudeMdLoaded = false;
    this.pendingToolCalls.clear();
    this.fileReadCounts.clear();
    this.turnCount = 0;
    this.lastCacheHitTurn = -1;
    this.lastUserPrompt = '';
    this.lastPromptAnalyzed = false;
    this.hadFileReadThisTurn = false;
  }

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return [];

    let entry: RawEntry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];
    const now = Date.now();

    // ── Detect CWD (first occurrence → CLAUDE.md load check) ──
    if (entry.cwd && !this.cwd) {
      this.cwd = entry.cwd;
      if (!this.claudeMdLoaded) {
        this.claudeMdLoaded = true;
        const ev = this.buildClaudeMdEvent(this.cwd, now);
        if (ev) events.push(ev);
      }
    }

    // ── Normalise entry type ──
    const entryType = (entry.type || '').toLowerCase();
    const message = entry.message;

    // ── System messages (compaction) ──
    if (entryType === 'system') {
      const text = this.extractText(entry.content ?? message?.content);
      if (this.looksLikeCompaction(text)) {
        events.push(this.buildCompactionEvent(text, now));
      }
      return events;
    }

    if (!message) return events;

    // Track model from assistant messages
    if (message.model) {
      this.model = message.model;
    }

    // ── Assistant messages ──
    if (entryType === 'assistant') {
      this.turnCount++;
      this.hadFileReadThisTurn = false;

      const usage = message.usage;

      // Always emit TURN_COMPLETED so the cost counter updates on every exchange.
      // Cost = input + cache_write + output  (cache_read cost tracked separately in CACHE_HIT)
      if (usage) {
        const p = getPricing(this.model);
        const inputTokens  = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const cacheWrite   = usage.cache_creation_input_tokens ?? 0;
        const turnCost = calcInputCost(inputTokens, this.model)
          + tokToMTok(cacheWrite) * p.cacheWritePrice
          + calcOutputCost(outputTokens, this.model);
        const totalTokens  = inputTokens + outputTokens + cacheWrite + (usage.cache_read_input_tokens ?? 0);
        events.push({
          type: 'TURN_COMPLETED',
          timestamp: now,
          tokens: totalTokens,
          savedTokens: 0,
          cost: turnCost,
          savedCost: 0,
          normalCost: turnCost,
          outputCost: calcOutputCost(outputTokens, this.model),
          label: 'Turn completed',
          detail: `${fmtTokens(totalTokens)} tokens this exchange`,
          model: this.model,
        });

        if (this.lastUserPrompt && !this.lastPromptAnalyzed) {
          const improvement = analyzePrompt(this.lastUserPrompt, this.hadFileReadThisTurn, outputTokens);
          if (improvement) {
            this.lastPromptAnalyzed = true;
            const truncated = this.lastUserPrompt.length > 60
              ? this.lastUserPrompt.slice(0, 60) + '...'
              : this.lastUserPrompt;
            events.push({
              type: 'VAGUE_PROMPT',
              timestamp: now,
              tokens: 0,
              savedTokens: 0,
              cost: 0,
              savedCost: 0,
              normalCost: 0,
              label: `Prompt improvement: ${improvement.issue}`,
              detail: `"${truncated}"`,
              advice: improvement.suggestion,
              model: this.model,
            });
          }
        }
      }

      // Cache hit — tracks savings on top of TURN_COMPLETED base cost
      if (usage?.cache_read_input_tokens && usage.cache_read_input_tokens > 0) {
        this.lastCacheHitTurn = this.turnCount;
        events.push(this.buildCacheHitEvent(usage, now));
      }

      // Tool uses in content
      const content = message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            // Store pending tool call for later correlation with tool_result
            this.pendingToolCalls.set(block.id, {
              name: block.name,
              input: block.input || {},
            });

            // Immediately detect plugin / skill / agent by tool name
            const toolEvent = this.classifyToolUse(block.name, block.input || {}, now);
            if (toolEvent) events.push(toolEvent);
          }
        }
      }
    }

    // ── User messages (tool results) ──
    if (entryType === 'user') {
      const content = message.content;
      if (Array.isArray(content)) {
        const textBlocks = content.filter(b => b.type !== 'tool_result');
        if (textBlocks.length > 0) {
          this.lastUserPrompt = this.extractText(textBlocks).trim();
          this.lastPromptAnalyzed = false;
        }
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const pending = this.pendingToolCalls.get(block.tool_use_id);
            if (pending) {
              const ev = this.handleToolResult(pending, block, now);
              if (ev) events.push(ev);
              // Clean up after use
              this.pendingToolCalls.delete(block.tool_use_id);
            }
          }
        }
      }
    }

    // Stamp every event with the session's cwd so the extension can route it
    if (this.cwd) {
      for (const ev of events) ev.sessionCwd = this.cwd;
    }

    return events;
  }

  // ─── Accessors ────────────────────────────────────────────

  getCurrentTurn(): number { return this.turnCount; }
  getLastCacheHitTurn(): number { return this.lastCacheHitTurn; }
  getCwd(): string | undefined { return this.cwd; }

  // ─── Private builders ──────────────────────────────────────

  private buildClaudeMdEvent(cwd: string, now: number): ParsedEvent | null {
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    let tokens = 0;
    try {
      const stat = fs.statSync(claudeMdPath);
      tokens = Math.round(stat.size / 4);
    } catch {
      return null; // No CLAUDE.md — nothing to report
    }

    const cost = calcInputCost(tokens, this.model);
    const advice = tokens > 2000
      ? `Move rarely used rules to skills — saves ~${fmtTokens(tokens)} tokens every session (~${
          (calcInputCost(tokens, this.model) * 20).toFixed(3)
        }/day at 20 sessions)`
      : undefined;

    return {
      type: 'CLAUDE_MD_LOAD',
      timestamp: now,
      tokens,
      savedTokens: 0,
      cost,
      savedCost: 0,
      normalCost: cost,
      label: 'CLAUDE.md loaded',
      detail: `${fmtTokens(tokens)} tokens overhead this session`,
      advice,
      model: this.model,
    };
  }

  private buildCacheHitEvent(usage: TokenUsage, now: number): ParsedEvent {
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const { actualCost, normalCost, savedCost } = calcCacheHitCost(cacheReadTokens, this.model);

    return {
      type: 'CACHE_HIT',
      timestamp: now,
      tokens: cacheReadTokens,
      savedTokens: cacheReadTokens,
      cost: actualCost,
      savedCost,
      normalCost,
      label: 'Cache hit',
      detail: `${fmtTokens(cacheReadTokens)} tokens served from cache`,
      model: this.model,
    };
  }

  private classifyToolUse(name: string, input: Record<string, unknown>, now: number): ParsedEvent | null {
    // Plugin: name contains colon → <plugin-name>:<tool-name>
    if (name.includes(':')) {
      const pluginName = name.split(':')[0];
      return {
        type: 'PLUGIN_FIRED',
        timestamp: now,
        tokens: 0,
        savedTokens: 0,
        cost: 0,
        savedCost: 0,
        normalCost: 0,
        label: `Plugin ${pluginName} fired`,
        detail: 'Handled tokens internally',
        featureName: pluginName,
        model: this.model,
      };
    }

    // Skill/Agent: built-in "Task" | "Agent", or matches known installed names
    const nameLower = name.toLowerCase();
    if (
      name === 'Task' ||
      name === 'Agent' ||
      this.knownToolNames.has(nameLower)
    ) {
      // Extract real agent name from subagent_type or description
      const subagentType = input.subagent_type as string | undefined;
      const description = input.description as string | undefined;
      const featureName = subagentType || (nameLower !== 'task' && nameLower !== 'agent' ? name : undefined) || description?.split(' ')[0] || name;

      return {
        type: 'SKILL_AGENT_USED',
        timestamp: now,
        tokens: 0,
        savedTokens: 0,
        cost: 0,
        savedCost: 0,
        normalCost: 0,
        label: `${featureName} used`,
        detail: 'Tokens isolated from main context',
        featureName,
        model: this.model,
      };
    }

    return null;
  }

  private handleToolResult(
    pending: { name: string; input: Record<string, unknown> },
    block: ContentBlock,
    now: number
  ): ParsedEvent | null {
    const toolName = pending.name;
    const resultText = this.extractText(block.content);
    const estimatedTokens = Math.round(resultText.length / 4);

    // ── Read tool: large file / repeated file ──
    if (toolName === 'Read') {
      this.hadFileReadThisTurn = true;
      const filePath = (pending.input.file_path as string) || '';

      // Track read counts for repeated-file detection
      const readCount = (this.fileReadCounts.get(filePath) || 0) + 1;
      this.fileReadCounts.set(filePath, readCount);

      if (readCount > 2) {
        return {
          type: 'REPEATED_FILE_READ',
          timestamp: now,
          tokens: estimatedTokens,
          savedTokens: 0,
          cost: calcInputCost(estimatedTokens, this.model),
          savedCost: 0,
          normalCost: calcInputCost(estimatedTokens, this.model),
          label: `Repeated file read`,
          detail: `${path.basename(filePath)} read ${readCount} times this session`,
          advice: `You've read ${path.basename(filePath)} ${readCount} times — add a summary to CLAUDE.md`,
          filePath,
          model: this.model,
        };
      }

      if (estimatedTokens > 3000) {
        const cost = calcInputCost(estimatedTokens, this.model);
        return {
          type: 'LARGE_FILE_READ',
          timestamp: now,
          tokens: estimatedTokens,
          savedTokens: 0,
          cost,
          savedCost: 0,
          normalCost: cost,
          label: 'Large file read directly',
          detail: `${fmtTokens(estimatedTokens)} tokens into main context`,
          advice: `A skill or subagent would have isolated these ${fmtTokens(estimatedTokens)} tokens. Est saving: $${cost.toFixed(4)}`,
          filePath,
          model: this.model,
        };
      }
    }

    // ── Task/Agent: update token count from result ──
    if ((toolName === 'Task' || toolName === 'Agent') && estimatedTokens > 0) {
      // Agent returned a summary of X tokens to main context.
      // Without the agent, main context would have processed all that work inline.
      // Conservative estimate: agent did ~6x more work than its summary.
      const subagentType = pending.input.subagent_type as string | undefined;
      const featureName = subagentType || toolName;
      const estimatedAgentWork = estimatedTokens * 6;
      const savedTokens = estimatedAgentWork - estimatedTokens;
      const actualCost = calcInputCost(estimatedTokens, this.model);
      const normalCost = calcInputCost(estimatedAgentWork, this.model);
      const savedCost = normalCost - actualCost;

      return {
        type: 'SKILL_AGENT_USED',
        timestamp: now,
        tokens: estimatedAgentWork,
        savedTokens,
        cost: actualCost,
        savedCost,
        normalCost,
        label: `${featureName} completed`,
        detail: `Main context got ${fmtTokens(estimatedTokens)} summary — ~${fmtTokens(estimatedAgentWork)} kept out`,
        featureName,
        model: this.model,
      };
    }

    return null;
  }

  private buildCompactionEvent(text: string, now: number): ParsedEvent {
    // Extract percentage if present (e.g. "at 87% context usage")
    const percentMatch = text.match(/(\d+)%/);
    const percentStr = percentMatch?.[1] ?? '?';
    const percent = percentMatch ? parseInt(percentMatch[1], 10) : 100;

    // Extract token count if present
    const tokenMatch = text.match(/(\d[\d,]+)\s*tokens?/i);
    const tokens = tokenMatch ? parseInt(tokenMatch[1].replace(/,/g, ''), 10) : 0;

    const savedCost = calcCompactionSaving(tokens, this.model);

    const advice = percent < 50
      ? 'Compaction fired early — break tasks into smaller turns'
      : undefined;

    return {
      type: 'COMPACTION_FIRED',
      timestamp: now,
      tokens,
      savedTokens: tokens,
      cost: 0,
      savedCost,
      normalCost: savedCost,
      label: 'Compaction fired',
      detail: `At ${percentStr}% — ${fmtTokens(tokens)} tokens cleared`,
      advice,
      model: this.model,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────

  private extractText(content: string | ContentBlock[] | undefined): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    return content
      .map(b => {
        if (typeof b === 'string') return b;
        if (b.text) return b.text;
        if (b.content) return this.extractText(b.content);
        return '';
      })
      .join('');
  }

  private looksLikeCompaction(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.includes('compaction') ||
      lower.includes('context_window_compaction') ||
      lower.includes('context has been compacted') ||
      lower.includes('context window has been compacted') ||
      lower.includes('compact')
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Prompt analysis — detects weak patterns and returns a specific
// improvement suggestion. Returns null if the prompt looks fine.
// ─────────────────────────────────────────────────────────────

function hasFilePath(text: string): boolean {
  return /[a-zA-Z0-9_\-]+\.(ts|js|tsx|jsx|py|json|md|css|html|sh)/.test(text)
    || /line\s+\d+/i.test(text)
    || /:\d+/.test(text);
}

function analyzePrompt(
  text: string,
  hadFileRead: boolean,
  outputTokens: number
): { issue: string; suggestion: string } | null {
  const lower = text.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);

  // Vague pronoun as the main subject with no file context
  if (/^(fix |check |update |change |look at |review )?(this|it|that)\b/.test(lower) && !hasFilePath(text)) {
    return {
      issue: 'vague reference',
      suggestion: `Replace "this/it/that" with the specific file or function. Try: "${words[0]} [filename.ts]:line — [what to change]"`,
    };
  }

  // Action verb with no file path, and the turn read files or produced a long response
  if (/\b(fix|repair|correct|update|change|edit|refactor)\b/.test(lower) && !hasFilePath(text) && (hadFileRead || outputTokens > 2000)) {
    return {
      issue: 'action missing target',
      suggestion: 'Add the file and what to change. Try: "Fix [issue] in [file.ts]:line — expected [X], currently does [Y]"',
    };
  }

  // Why/what question with no expected vs actual
  if (/^why (is|isn'?t|are|aren'?t|does|doesn'?t|won'?t|can'?t)\b/.test(lower) && words.length < 10) {
    return {
      issue: 'question missing expected vs actual',
      suggestion: 'Add context: "Why does [X] happen? Expected [Y] but getting [Z] — relevant file: [file.ts]"',
    };
  }

  // Multi-task: two or more "and also" / "then" / separate sentences
  const taskJoins = (text.match(/\band\b|\bthen\b|\balso\b/gi) || []).length;
  if (taskJoins >= 2 && words.length > 20) {
    return {
      issue: 'multiple tasks in one prompt',
      suggestion: 'Split into separate prompts — one task per message gets more precise results and uses fewer tokens per turn',
    };
  }

  // Bare verb command (1–3 words, starts with an imperative)
  if (words.length <= 3 && /^(check|fix|run|do|show|get|make|add|update|change|help|explain|debug)\b/.test(lower)) {
    return {
      issue: 'command too bare',
      suggestion: `Add what + where. Try: "${words[0]} [specific thing] in [file.ts] — [any extra context]"`,
    };
  }

  // No file path and caused file reads (Claude had to explore)
  if (!hasFilePath(text) && hadFileRead && words.length < 15) {
    return {
      issue: 'missing file context caused exploration',
      suggestion: 'Paste the relevant file path or code snippet — Claude can skip reading files when context is already in the prompt',
    };
  }

  return null;
}
