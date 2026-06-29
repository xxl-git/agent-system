// Type declarations for AgentCore members
import type { SmartAdapter } from '../smart-adapter';
import type { IntentParser, ParsedIntent } from '../intent-parser';
import type { Orchestrator } from '../orchestrator';
import type { ProjectManager } from '../projects/project-manager';
import type { SmartRouter } from '../../models/router/smart-router';
import type { BreakInMachine } from '../../models/adaptation/break-in-machine';
import type { ChatMessage } from '../../models/adapters/lmstudio';
import type { SkillAuditor, SkillDeveloper, SkillTester, SkillEquipper } from '../../skills/pipeline';
import type { AgentBus, ParallelScheduler, ResultMerger } from '../../agents/collaboration';
import type { SubAgent } from '../../agents/sub-agent';
import type { RecoveryOrchestrator } from '../../resilience/orchestrator';
import type { HealthMonitor } from '../../resilience/health-monitor';
import type { CircuitBreaker } from '../../resilience/circuit-breaker';
import type { CheckpointManager } from '../../resilience/checkpoint';
import type { SessionRecoverer, MemoryInjection } from '../../memory/session-recovery';
import type { MemorySummarizer } from '../../memory/summarizer';
import type { AuditLog } from '../../audit/audit-log';
import type { ContextManager } from '../context-manager';
import type { IdleTaskManager } from '../../resilience/idle-task-manager';
import type { NonsenseDetector } from '../../resilience/nonsense-detector';
import type { SessionDiagnostics } from '../../resilience/session-diagnostics';
import type { DecisionRecord } from '../../memory/db-store';
export type {
  SmartAdapter, IntentParser, ParsedIntent, Orchestrator, ProjectManager,
  SmartRouter, BreakInMachine, ChatMessage,
  SkillAuditor, SkillDeveloper, SkillTester, SkillEquipper,
  AgentBus, ParallelScheduler, ResultMerger, SubAgent,
  RecoveryOrchestrator, HealthMonitor, CircuitBreaker, CheckpointManager,
  SessionRecoverer, MemoryInjection, MemorySummarizer, AuditLog,
  ContextManager, IdleTaskManager, NonsenseDetector, SessionDiagnostics,
  DecisionRecord
};