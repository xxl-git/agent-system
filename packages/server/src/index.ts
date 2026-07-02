/**
 * @agent-system/server - Type-only package stub
 *
 * This package provides type-level exports for the agent server module.
 * The actual server implementation lives in src/server/agent-server.ts
 * (compiled as part of the root project -> dist/server/agent-server.js).
 *
 * Architecture:
 *   packages/* /   -> Extractable npm packages (reusable across projects)
 *   src/          -> Main application (imports from packages/* /)
 */

// Re-export types from core packages
export type { ChatMessage } from '@agent-system/llm';
