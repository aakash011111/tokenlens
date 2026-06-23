import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface InstalledFeature {
  name: string;
  type: 'plugin' | 'agent' | 'skill' | 'hook' | 'other';
  path: string;
  createdAt?: Date;
  firedCount: number;
  tokensSaved: number;
  isGlobal: boolean;
}

interface ScanLocation {
  dir: string;
  type: InstalledFeature['type'];
  isGlobal: boolean;
}

function getScanLocations(workspaceRoot: string): ScanLocation[] {
  const home = os.homedir();
  return [
    { dir: path.join(home, '.claude', 'plugins'),       type: 'plugin', isGlobal: true  },
    { dir: path.join(home, '.claude', 'agents'),        type: 'agent',  isGlobal: true  },
    { dir: path.join(workspaceRoot, '.claude', 'agents'),  type: 'agent',  isGlobal: false },
    { dir: path.join(workspaceRoot, '.claude', 'skills'),  type: 'skill',  isGlobal: false },
    { dir: path.join(workspaceRoot, '.claude', 'hooks'),   type: 'hook',   isGlobal: false },
    { dir: path.join(workspaceRoot, 'graphify-out'),       type: 'other',  isGlobal: false },
    { dir: path.join(home, '.claude', 'decision-log'),  type: 'other',  isGlobal: true  },
  ];
}

export function scanInstalledFeatures(workspaceRoot: string): InstalledFeature[] {
  const features: InstalledFeature[] = [];
  const seen = new Set<string>();
  const locations = getScanLocations(workspaceRoot);

  for (const loc of locations) {
    if (!fs.existsSync(loc.dir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(loc.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(loc.dir, entry.name);
      const key = `${loc.type}:${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      let createdAt: Date | undefined;
      try {
        const stat = fs.statSync(fullPath);
        createdAt = stat.birthtime && stat.birthtime.getFullYear() > 1970
          ? stat.birthtime
          : stat.ctime;
      } catch {
        // ignore
      }

      // Strip extension from display name for agents/skills
      const displayName = (loc.type === 'agent' || loc.type === 'skill')
        ? entry.name.replace(/\.(md|json|ts|js|sh)$/, '')
        : entry.name;

      features.push({
        name: displayName,
        type: loc.type,
        path: fullPath,
        createdAt,
        firedCount: 0,
        tokensSaved: 0,
        isGlobal: loc.isGlobal,
      });
    }
  }

  return features;
}

/** Returns just the base names (no extension) for agent and skill files — used by parser to match tool_use names. */
export function getKnownToolNames(features: InstalledFeature[]): string[] {
  return features
    .filter(f => f.type === 'agent' || f.type === 'skill')
    .map(f => f.name.toLowerCase());
}
