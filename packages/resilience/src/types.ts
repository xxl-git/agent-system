// Resilience package — local type definitions (decoupled from root project)

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface SubTask {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  tool?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'done';
  result?: string;
  error?: string;
  retries?: number;
  priority?: number;
}

export interface TaskDAG {
  id: string;
  title: string;
  description: string;
  tasks: SubTask[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  originalRequest?: string;
}
