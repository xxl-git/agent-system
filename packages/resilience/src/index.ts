// Resilience Module — barrel export
export { CircuitBreaker, getCircuitBreaker } from './circuit-breaker';
export type { CircuitState, CircuitBreakerInstance, CircuitBreakerConfig } from './circuit-breaker';
export { RetryEngine, getRetryEngine } from './retry-engine';
export type { FailureType, BackoffAlgorithm, RecoveryAction, RetryStrategy, ClassifiedFailure, RetryResult } from './retry-engine';
export { HealthMonitor, getHealthMonitor } from './health-monitor';
export type { MonitorChannel, FailureLevel, HealthEvent, HealthMonitorConfig } from './health-monitor';
export { DegradationPath, getDegradationPath } from './degradation';
export type { DegradationLevel, DegradationResult, DegradationConfig } from './degradation';
export { CheckpointManager, getCheckpointManager } from './checkpoint';
export type { FailureRecord, TaskCheckpoint, CompletedStep, CheckpointConfig } from './checkpoint';
export type { SubTask, TaskDAG, ChatMessage } from './types';
export { IdleTaskManager, getIdleTaskManager } from './idle-task-manager';
export type { IdleTaskPriority, IdleTask, IdleTaskLogEntry } from './idle-task-manager';
export { NonsenseDetector, getNonsenseDetector } from './nonsense-detector';
export type { ConversationRecord } from './nonsense-detector';
export { RecoveryOrchestrator, getRecoveryOrchestrator } from './orchestrator';
export type { ProtectedContext, ProtectedResult, RecoveryConfig } from './orchestrator';
export { SessionDiagnostics, getSessionDiagnostics } from './session-diagnostics';
export type { DiagnosticSnapshot } from './session-diagnostics';
export { Tracer, getTracer, finishTrace, getTraceReport, getRecentTraces } from './tracer';
export type { TraceSpan, TraceReport } from './tracer';
export { createAssemblyReport, addAssemblyStage, formatAssemblyReport, getAssemblyReport } from './assembly-inspector';
export type { AssemblyReport, AssemblyStage } from './assembly-inspector';

export { logger } from './logger';