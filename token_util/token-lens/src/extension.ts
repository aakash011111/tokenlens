import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SessionWatcher } from './sessionWatcher';
import { ParsedEvent } from './parser';
import { AdviceEngine } from './adviceEngine';
import { scanInstalledFeatures, InstalledFeature, getKnownToolNames } from './scanner';
import { fmtUSD, fmtTokens, calcInputCost } from './pricer';

// ─────────────────────────────────────────────────────────────
// Extension lifecycle
// ─────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const provider = new TokenLensViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(TokenLensViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenLens.refresh', () => provider.refresh())
  );
}

export function deactivate() {}

// ─────────────────────────────────────────────────────────────
// Tab state — one per view (project + global)
// ─────────────────────────────────────────────────────────────

interface TabState {
  paidCost: number;
  savedCost: number;
  lastEvent?: ParsedEvent;
  features: InstalledFeature[];
  adviceEngine: AdviceEngine;
  sessionFile: string;
  costOutput: number;
  costInput: number;
  costCacheRead: number;
  costFileRead: number;
  costClaudeMd: number;
}

function makeTabState(baseFeatures: InstalledFeature[]): TabState {
  // Deep-copy features so each tab has independent fire counts
  const features = baseFeatures.map(f => ({ ...f, firedCount: 0, tokensSaved: 0 }));
  const adviceEngine = new AdviceEngine();
  adviceEngine.setInstalledFeatures(features.map(f => ({ name: f.name, type: f.type, firedCount: 0 })));
  return { paidCost: 0, savedCost: 0, features, adviceEngine, sessionFile: '',
           costOutput: 0, costInput: 0, costCacheRead: 0, costFileRead: 0, costClaudeMd: 0 };
}

function resetTabState(tab: TabState) {
  tab.paidCost = 0;
  tab.savedCost = 0;
  tab.lastEvent = undefined;
  tab.costOutput = 0;
  tab.costInput = 0;
  tab.costCacheRead = 0;
  tab.costFileRead = 0;
  tab.costClaudeMd = 0;
  tab.adviceEngine.reset();
  for (const f of tab.features) { f.firedCount = 0; f.tokensSaved = 0; }
}

// ─────────────────────────────────────────────────────────────
// View-model shapes sent to webview
// ─────────────────────────────────────────────────────────────

interface FeatureVM {
  name: string; type: string;
  firedCount: number;
  tokensSaved: number; tokensSavedFmt: string; savedCostFmt: string;
}

interface LastEventVM {
  type: string; label: string; detail: string;
  tokensFmt: string; costFmt: string; savedCostFmt: string; normalCostFmt: string;
  ageMs: number; advice?: string;
}

interface TabVM {
  paidCostFmt: string;
  savedCostFmt: string;
  efficiency: number;
  sessionFile: string;
  lastEvent?: LastEventVM;
  features: FeatureVM[];
  advice: ReturnType<AdviceEngine['generateAdvice']>;
  breakdown: {
    output: number; outputFmt: string;
    input: number; inputFmt: string;
    cacheRead: number; cacheReadFmt: string;
    fileRead: number; fileReadFmt: string;
    claudeMd: number; claudeMdFmt: string;
    total: number;
  };
}

// ─────────────────────────────────────────────────────────────
// WebviewView provider
// ─────────────────────────────────────────────────────────────

class TokenLensViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'tokenLens.panel';

  private view?: vscode.WebviewView;
  private watcher: SessionWatcher;
  private workspaceRoot: string;
  private installedFeatures: InstalledFeature[];

  // Two independent tabs
  private projectTab: TabState;
  private globalTab: TabState;
  private activeTab: 'project' | 'global' = 'project';

  constructor(private readonly extensionUri: vscode.Uri) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    this.installedFeatures = scanInstalledFeatures(this.workspaceRoot);

    this.projectTab = makeTabState(this.installedFeatures);
    this.globalTab  = makeTabState(this.installedFeatures);

    this.watcher = new SessionWatcher();
    this.watcher.setKnownToolNames(getKnownToolNames(this.installedFeatures));
    this.setupWatcher();
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src', 'webview')],
    };

    webviewView.webview.html = this.buildHtml(webviewView.webview);

    // Handle tab-switch messages from the webview
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'switchTab' && (msg.tab === 'project' || msg.tab === 'global')) {
        this.activeTab = msg.tab;
        this.pushUpdate();
      }
    });

    setTimeout(() => this.pushUpdate(), 300);
  }

  refresh() {
    if (!this.view) return;
    this.view.webview.html = this.buildHtml(this.view.webview);
    setTimeout(() => this.pushUpdate(), 300);
  }

  // ─── Watcher wiring ──────────────────────────────────────

  private setupWatcher() {
    this.watcher.on('sessionChanged', (filePath: string, sessionCwd?: string) => {
      const isProject = this.belongsToProject(sessionCwd);
      const fileLabel = path.basename(path.dirname(filePath)) + '/' + path.basename(filePath);

      if (isProject) {
        this.projectTab.sessionFile = fileLabel;
      }

      this.globalTab.sessionFile = fileLabel;

      this.pushUpdate();
    });

    this.watcher.on('event', (event: ParsedEvent) => this.handleEvent(event));
    this.watcher.on('error', (err: Error) => console.error('[TokenLens]', err.message));
    this.watcher.start();
  }

  private handleEvent(event: ParsedEvent) {
    const isProject = this.belongsToProject(event.sessionCwd);

    // TURN_COMPLETED — update costs only, not Last Event
    if (event.type === 'TURN_COMPLETED') {
      const outCost = event.outputCost ?? 0;
      const inCost = event.cost - outCost;
      this.globalTab.paidCost += event.cost;
      this.globalTab.costOutput += outCost;
      this.globalTab.costInput += inCost;
      if (isProject) {
        this.projectTab.paidCost += event.cost;
        this.projectTab.costOutput += outCost;
        this.projectTab.costInput += inCost;
      }
      this.pushUpdate();
      return;
    }

    // All notable events go to global; project-matched events also go to project
    this.feedTab(this.globalTab, event);
    if (isProject) this.feedTab(this.projectTab, event);

    this.pushUpdate();
  }

  private feedTab(tab: TabState, event: ParsedEvent) {
    tab.paidCost  += event.cost;
    tab.savedCost += event.savedCost;
    tab.lastEvent  = event;

    if (event.featureName) {
      const key = event.featureName.toLowerCase();
      let feat = tab.features.find(f => f.name.toLowerCase() === key);
      if (!feat) {
        feat = {
          name: event.featureName, type: event.type === 'PLUGIN_FIRED' ? 'plugin' : 'other',
          path: '', firedCount: 0, tokensSaved: 0, isGlobal: false,
        };
        tab.features.push(feat);
      }
      feat.firedCount++;
      feat.tokensSaved += event.savedTokens;
    }

    tab.adviceEngine.addEvent(event);
    tab.adviceEngine.setInstalledFeatures(
      tab.features.map(f => ({ name: f.name, type: f.type, firedCount: f.firedCount }))
    );

    if (event.type === 'CACHE_HIT') {
      tab.costCacheRead += event.cost;
    } else if (event.type === 'LARGE_FILE_READ' || event.type === 'REPEATED_FILE_READ') {
      tab.costFileRead += event.cost;
    } else if (event.type === 'CLAUDE_MD_LOAD') {
      tab.costClaudeMd += event.cost;
    }
  }

  // ─── Predicate ───────────────────────────────────────────

  private belongsToProject(sessionCwd?: string): boolean {
    if (!sessionCwd || !this.workspaceRoot) return false;
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    return norm(sessionCwd) === norm(this.workspaceRoot) ||
           norm(sessionCwd).startsWith(norm(this.workspaceRoot) + '/');
  }

  // ─── UI update ────────────────────────────────────────────

  private pushUpdate() {
    if (!this.view) return;

    this.view.webview.postMessage({
      type: 'update',
      state: {
        activeTab: this.activeTab,
        project:   this.buildTabVM(this.projectTab),
        global:    this.buildTabVM(this.globalTab),
      },
    });
  }

  private buildTabVM(tab: TabState): TabVM {
    const total = tab.paidCost + tab.savedCost;
    const efficiency = total > 0 ? Math.round((tab.savedCost / total) * 100) : 0;

    return {
      paidCostFmt:  fmtUSD(tab.paidCost),
      savedCostFmt: fmtUSD(tab.savedCost),
      efficiency,
      sessionFile: tab.sessionFile,
      lastEvent: tab.lastEvent ? {
        type:          tab.lastEvent.type,
        label:         tab.lastEvent.label,
        detail:        tab.lastEvent.detail,
        tokensFmt:     fmtTokens(tab.lastEvent.tokens),
        costFmt:       fmtUSD(tab.lastEvent.cost),
        savedCostFmt:  fmtUSD(tab.lastEvent.savedCost),
        normalCostFmt: fmtUSD(tab.lastEvent.normalCost),
        ageMs:         Date.now() - tab.lastEvent.timestamp,
        advice:        tab.lastEvent.advice,
      } : undefined,
      features: tab.features
        .filter(f => f.firedCount > 0)
        .sort((a, b) => b.tokensSaved - a.tokensSaved)
        .slice(0, 8)
        .map(f => ({
          name: f.name, type: f.type,
          firedCount: f.firedCount,
          tokensSaved: f.tokensSaved,
          tokensSavedFmt: fmtTokens(f.tokensSaved),
          savedCostFmt:   fmtUSD(calcInputCost(f.tokensSaved, 'claude-sonnet-4-6')),
        })),
      advice: tab.adviceEngine.generateAdvice(efficiency),
      breakdown: {
        output:       tab.costOutput,
        outputFmt:    fmtUSD(tab.costOutput),
        input:        tab.costInput,
        inputFmt:     fmtUSD(tab.costInput),
        cacheRead:    tab.costCacheRead,
        cacheReadFmt: fmtUSD(tab.costCacheRead),
        fileRead:     tab.costFileRead,
        fileReadFmt:  fmtUSD(tab.costFileRead),
        claudeMd:     tab.costClaudeMd,
        claudeMdFmt:  fmtUSD(tab.costClaudeMd),
        total:        tab.costOutput + tab.costInput + tab.costCacheRead,
      },
    };
  }

  // ─── HTML generation ─────────────────────────────────────

  private buildHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'panel.js')
    );

    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'panel.html');
    let html: string;
    try {
      html = fs.readFileSync(htmlPath, 'utf8');
    } catch {
      return `<html><body style="color:var(--vscode-foreground);padding:12px">
        <p>Token Lens loading…</p>
        <p style="font-size:11px;opacity:.5">Watching ~/.claude/projects/ for Claude Code sessions</p>
      </body></html>`;
    }

    return html
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
  }
}
