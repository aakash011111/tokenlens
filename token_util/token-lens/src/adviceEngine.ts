import { ParsedEvent } from './parser';
import { fmtUSD } from './pricer';

export interface Advice {
  id: string;
  message: string;
  subtext?: string;
  severity: 'good' | 'warn' | 'tip';
}

interface FeatureSummary {
  name: string;
  type: string;
  firedCount: number;
}

export class AdviceEngine {
  private events: ParsedEvent[] = [];
  private recentTurnCount = 0;
  private recentCacheHits = 0;
  private windowEvents: ParsedEvent[] = [];
  private installedFeatures: FeatureSummary[] = [];

  setInstalledFeatures(features: FeatureSummary[]) {
    this.installedFeatures = features;
  }

  addEvent(event: ParsedEvent) {
    if (event.type === 'TURN_COMPLETED') {
      this.recentTurnCount++;
      this.windowEvents.push(event);
      if (this.windowEvents.length > 10) this.windowEvents.shift();
      return;
    }

    this.events.push(event);

    if (event.type === 'CACHE_HIT') {
      this.recentCacheHits++;
    }
  }

  generateAdvice(efficiency: number): Advice[] {
    const advice: Advice[] = [];

    // ── 1. Cache health (always shown) ───────────────────────
    if (this.recentTurnCount >= 3) {
      if (efficiency >= 80) {
        advice.push({
          id: 'cache-good',
          message: `Cache is working great (${efficiency}% efficient)`,
          subtext: 'Keep repeated context — like project rules and instructions — at the top of your prompts to maintain this',
          severity: 'good',
        });
      } else if (efficiency >= 50) {
        advice.push({
          id: 'cache-ok',
          message: `Cache efficiency is moderate (${efficiency}%)`,
          subtext: 'Move frequently repeated content to the top of your prompts — Claude caches the start of context first',
          severity: 'tip',
        });
      } else {
        advice.push({
          id: 'cache-low',
          message: `Low efficiency (${efficiency}%) — paying full price for most tokens`,
          subtext: 'Add a CLAUDE.md file with project rules — it gets cached automatically and read cheaply every turn after',
          severity: 'warn',
        });
      }
    }

    // ── 2. No cache hits in last 10 turns ────────────────────
    if (this.recentTurnCount >= 10 && this.recentCacheHits === 0) {
      advice.push({
        id: 'no-cache-hits',
        message: 'No cache hits in the last 10 exchanges',
        subtext: 'Place your system prompt and key instructions at the very top of each conversation — Claude caches those first',
        severity: 'warn',
      });
    }

    // ── 3. Installed agents not being used ───────────────────
    const agents = this.installedFeatures.filter(f => f.type === 'agent');
    const usedAgents = this.events
      .filter(e => e.type === 'SKILL_AGENT_USED')
      .map(e => e.featureName?.toLowerCase());
    const unusedAgents = agents.filter(a => !usedAgents.includes(a.name.toLowerCase()));

    if (unusedAgents.length > 0 && this.recentTurnCount >= 2) {
      const examples = unusedAgents.slice(0, 2).map(a => a.name).join(', ');
      advice.push({
        id: 'unused-agents',
        message: `${agents.length} agent${agents.length > 1 ? 's' : ''} installed but not used this session`,
        subtext: `Try: "use ${unusedAgents[0]?.name ?? 'debug-agent'} to investigate X" — agents run separately and keep their token usage out of your main context. Available: ${examples}${unusedAgents.length > 2 ? ` +${unusedAgents.length - 2} more` : ''}`,
        severity: 'tip',
      });
    } else if (usedAgents.length > 0) {
      const totalSaved = this.events
        .filter(e => e.type === 'SKILL_AGENT_USED')
        .reduce((s, e) => s + e.savedCost, 0);
      if (totalSaved > 0) {
        advice.push({
          id: 'agents-saving',
          message: `Agents are saving you money — ${fmtUSD(totalSaved)} isolated so far`,
          subtext: 'Keep delegating complex research and exploration to agents — your main context stays lean',
          severity: 'good',
        });
      }
    }

    // ── 4. Repeated file reads ────────────────────────────────
    const repeatedReads = this.events.filter(e => e.type === 'REPEATED_FILE_READ');
    if (repeatedReads.length > 0) {
      const latest = repeatedReads[repeatedReads.length - 1];
      const countMatch = latest.detail.match(/read (\d+) times/);
      const count = countMatch?.[1] ?? '3+';
      advice.push({
        id: 'repeated-reads',
        message: `${latest.filePath ? require('path').basename(latest.filePath) : 'A file'} re-read ${count} times this session`,
        subtext: 'Add a short summary of this file to CLAUDE.md — loaded once and cached instead of re-read every turn',
        severity: 'warn',
      });
    }

    // ── 5. Large file read directly ──────────────────────────
    const largeReads = this.events.filter(e => e.type === 'LARGE_FILE_READ');
    if (largeReads.length > 0) {
      const total = largeReads.reduce((s, e) => s + e.cost, 0);
      advice.push({
        id: 'large-reads',
        message: `${largeReads.length} large file${largeReads.length > 1 ? 's' : ''} loaded directly into context`,
        subtext: `Use a subagent to read and summarise large files — your context only gets the summary. Est. wasted: ${fmtUSD(total)}`,
        severity: 'warn',
      });
    }

    // ── 6. CLAUDE.md overhead ────────────────────────────────
    const claudeMd = this.events.find(e => e.type === 'CLAUDE_MD_LOAD');
    if (claudeMd && claudeMd.tokens > 2000) {
      advice.push({
        id: 'claude-md-large',
        message: `Project rules file is large (${claudeMd.tokens.toLocaleString()} tokens per session)`,
        subtext: `Move rarely-used rules to skills instead — saves ~${fmtUSD(claudeMd.cost)} per session`,
        severity: 'warn',
      });
    }

    // ── 7. Early compaction ──────────────────────────────────
    const earlyCompaction = this.events.find(e => {
      if (e.type !== 'COMPACTION_FIRED') return false;
      const pct = parseInt(e.detail.match(/(\d+)%/)?.[1] ?? '100', 10);
      return pct < 50;
    });
    if (earlyCompaction) {
      advice.push({
        id: 'early-compaction',
        message: 'Context was compacted early (before 50% full)',
        subtext: 'This usually means one task is doing too much. Break it into smaller focused prompts — each one stays within context limits longer',
        severity: 'warn',
      });
    }

    // ── 8. Skills installed but never used ──────────────────
    const skills = this.installedFeatures.filter(f => f.type === 'skill');
    if (skills.length > 0 && this.recentTurnCount >= 5) {
      const usedSkills = this.events
        .filter(e => e.type === 'SKILL_AGENT_USED')
        .map(e => e.featureName?.toLowerCase());
      const unusedSkills = skills.filter(s => !usedSkills.includes(s.name.toLowerCase()));
      if (unusedSkills.length >= 3) {
        advice.push({
          id: 'unused-skills',
          message: `${skills.length} skills installed for specialised tasks`,
          subtext: `Type /${unusedSkills[0]?.name ?? 'skill-name'} to invoke one. Skills expand to focused prompts that reduce context bloat`,
          severity: 'tip',
        });
      }
    }

    // ── 9. General tip (always shown when few events) ────────
    if (this.events.length < 3 && this.recentTurnCount < 5) {
      advice.push({
        id: 'general-start',
        message: 'Tip: put repeated context at the top of your prompts',
        subtext: 'Claude caches the beginning of context first. Project rules, coding standards, and repeated instructions placed at the top get cached and served cheaply on every turn after the first',
        severity: 'tip',
      });
    }

    // ── 10. Output token tip (always shown if high output) ───
    const outputHeavy = this.events.filter(e => e.type === 'TURN_COMPLETED' && e.tokens > 5000);
    if (outputHeavy.length > 0) {
      advice.push({
        id: 'output-tokens',
        message: 'Some responses were very long — output costs 5× more than input',
        subtext: 'Add "be concise" or "brief answer only" to prompts when you don\'t need a detailed explanation',
        severity: 'tip',
      });
    }

    // ── 11. Prompt improvements ──────────────────────────────────
    const vaguePrompts = this.events.filter(e => e.type === 'VAGUE_PROMPT');
    for (const vp of vaguePrompts.slice(0, 3)) {
      advice.push({
        id: `vague-prompt-${vp.timestamp}`,
        message: vp.label,
        subtext: `${vp.detail} — ${vp.advice}`,
        severity: 'tip',
      });
    }
    if (vaguePrompts.length > 3) {
      advice.push({
        id: 'vague-prompts-overflow',
        message: `+${vaguePrompts.length - 3} more prompts had improvement opportunities`,
        subtext: 'Specific prompts with file paths, line numbers, and expected vs actual behaviour let Claude act immediately.',
        severity: 'tip',
      });
    }

    // Deduplicate and cap at 10
    const seen = new Set<string>();
    return advice.filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    }).slice(0, 10);
  }

  reset() {
    this.events = [];
    this.recentTurnCount = 0;
    this.recentCacheHits = 0;
    this.windowEvents = [];
  }
}
