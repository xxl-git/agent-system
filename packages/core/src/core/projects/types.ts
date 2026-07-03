// 项目管理闭环 — 类型定义 (3.7)

export type ProjectStatus = 'in_progress' | 'paused' | 'completed' | 'archived';
export type Priority = 'P0' | 'P1' | 'P2';

export interface Checkpoint {
  lastSubtask: number;
  completed: number[];
  dagSnapshot: Record<string, unknown>;
  savedAt: string;
  sessionId: string;
}

export interface ProjectMeta {
  project: string;
  status: ProjectStatus;
  progress: number;         // 0-100
  priority: Priority;
  checkpoint: Checkpoint | null;
  active: boolean;
  created: string;
  updated: string;
  description?: string;
  tags?: string[];
}

export interface JournalEntry {
  timestamp: string;
  sessionId: string;
  action: string;           // what was done
  result: 'success' | 'partial' | 'failed';
  next: string;             // what's next
  notes?: string;
}

export interface TodoItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked';
  priority: Priority;
  dependsOn?: string[];     // todo ids
  createdAt: string;
  completedAt?: string;
}

export interface ProjectConfig {
  baseDir: string;          // projects/ directory
  autoSaveIntervalMs: number;
  maxCheckpoints: number;
  inactivityDaysToArchive: number;
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  baseDir: './projects',
  autoSaveIntervalMs: 300000,  // 5 min
  maxCheckpoints: 10,
  inactivityDaysToArchive: 7,
};

// Builder pattern — parse YAML frontmatter
export function parseFrontmatter(content: string): {
  meta: Partial<ProjectMeta>;
  body: string;
} {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return { meta: {}, body: content };

  const meta: Partial<ProjectMeta> = {};
  const fmLines = fmMatch[1].split('\n');
  for (const line of fmLines) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    let value: unknown = kv[2].trim();

    // Type coercion
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else if (/^\d+(\.\d+)?$/.test(value as string)) value = parseFloat(value as string);

    (meta as Record<string, unknown>)[key] = value;
  }

  return { meta, body: fmMatch[2] };
}

export function buildFrontmatter(meta: ProjectMeta): string {
  const lines = [
    `project: ${meta.project}`,
    `status: ${meta.status}`,
    `progress: ${meta.progress}`,
    `priority: ${meta.priority}`,
    `active: ${meta.active}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
  ];
  if (meta.description) lines.push(`description: "${meta.description}"`);
  if (meta.tags) {
    const tagList = Array.isArray(meta.tags) ? meta.tags : String(meta.tags).split(/,\s*/);
    if (tagList.length > 0) lines.push(`tags: [${tagList.join(', ')}]`);
  }

  return `---\n${lines.join('\n')}\n---\n`;
}
