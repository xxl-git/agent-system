// Resilience package — local type definitions (decoupled from root project)

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 统一 SubTask 类型 — 同时兼容 TaskDecomposer(src) 和 CheckpointManager(package) */
export interface SubTask {
  id: string;
  title: string;
  description: string;
  /** src/core/task-decomposer 使用 dependsOn；resilience 包内部用 dependencies，两者含义相同 */
  dependsOn: string[];
  dependencies: string[];
  tool?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'done' | 'failed' | 'skipped';
  /** 结构化结果（src 版） */
  result?: { success: boolean; output: string; error?: string };
  /** 扁平结果字符串（package 版） */
  resultText?: string;
  error?: string;
  retries?: number;
  priority?: number;
  /** src 版专用 */
  estimatedMinutes?: number;
}

export interface TaskDAG {
  // core/task-decomposer 使用 originalRequest + parallelGroups
  // checkpoint 使用 id + createdAt
  id?: string;
  title?: string;
  description?: string;
  tasks: SubTask[];
  status?: 'pending' | 'running' | 'completed' | 'failed';
  createdAt?: string;
  completedAt?: string;
  originalRequest?: string;
  parallelGroups?: string[][];
}
