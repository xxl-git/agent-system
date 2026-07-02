/**
 * @agent-system/core - Type-only package stub
 *
 * This package provides type-level exports for the core agent module.
 * The actual AgentCore implementation lives in src/core/agent/agent-core.ts
 * (compiled as part of the root project -> dist/core/agent/agent-core.js).
 *
 * Architecture:
 *   packages/* /   -> Extractable npm packages (reusable across projects)
 *   src/          -> Main application (imports from packages/* /)
 */

// Re-export types from other scoped packages
export type { ChatMessage, LLMCallRequest, LLMParams } from '@agent-system/llm';
export type { CircuitState } from '@agent-system/resilience';
