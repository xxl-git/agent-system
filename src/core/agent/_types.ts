// Type declarations for AgentCore members
import type { SmartAdapter } from '../smart-adapter';
import type { IntentParser, ParsedIntent } from '../intent-parser';
import type { Orchestrator } from '../orchestrator';
import type { ProjectManager } from '../projects/project-manager';
import type { SmartRouter } from '../../models/router/smart-router';
import type { BreakInMachine } from '../../models/adaptation/break-in-machine';
import type { ChatMessage } from '../../models/adapters/lmstudio';
import type { SkillAuditor, SkillDeveloper, SkillTester, SkillEquipper } from '@agent-system/skills';
import type { AgentBus, ParallelScheduler, ResultMerger } from '../../agents/collaboration';
import type { SubAgent } from '../../agents/sub-agent';
import type { RecoveryOrchestrator } from '@agent-system/resilience';
import type { HealthMonitor } from '@agent-system/resilience';
import type { CircuitBreaker } from '@agent-system/resilience';
import type { CheckpointManager } from '@agent-system/resilience';
import type { SessionRecoverer, MemoryInjection } from '@agent-system/memory';
import type { MemorySummarizer } from '@agent-system/memory';
import type { AuditLog } from '../../audit/audit-log';
import type { ContextManager } from '../context-manager';
import type { IdleTaskManager } from '@agent-system/resilience';
import type { NonsenseDetector } from '@agent-system/resilience';
import type { SessionDiagnostics } from '@agent-system/resilience';
import type { DecisionRecord } from '@agent-system/memory';
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