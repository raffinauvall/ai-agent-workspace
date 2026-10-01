// Tauri IPC event types — typed events for Rust <-> JS communication

import type { AgentState } from "./agent";
import type { OfficeLayout } from "./office";

// Rust -> JS event names
export const TAURI_EVENTS = {
  AGENT_FOUND: "agent:found",
  AGENT_LOST: "agent:lost",
  AGENT_STATE_CHANGED: "agent:state-changed",
  OFFICE_LAYOUT_CHANGED: "office:layout-changed",
} as const;

// Rust -> JS event payloads
export interface AgentFoundPayload {
  agent: AgentState;
}

export interface AgentLostPayload {
  id: string;
}

export interface AgentStateChangedPayload {
  agent: AgentState;
}

export interface OfficeLayoutChangedPayload {
  layout: OfficeLayout;
}

// Tauri event map — maps event names to payload types
export interface TauriEventMap {
  [TAURI_EVENTS.AGENT_FOUND]: AgentFoundPayload;
  [TAURI_EVENTS.AGENT_LOST]: AgentLostPayload;
  [TAURI_EVENTS.AGENT_STATE_CHANGED]: AgentStateChangedPayload;
  [TAURI_EVENTS.OFFICE_LAYOUT_CHANGED]: OfficeLayoutChangedPayload;
}

// Tauri invoke command names
export const TAURI_COMMANDS = {
  GET_ALL_AGENTS: "get_all_agents",
  GET_AGENT: "get_agent",
  GET_CONFIG: "get_config",
  SET_CONFIG: "set_config",
  GET_STATS: "get_stats",
  GET_AGENT_ACTIVITIES: "get_agent_activities",
  GET_REMOTE_CAPABILITIES: "get_remote_capabilities",
  CREATE_MANAGED_AGENT: "create_managed_agent",
  SEND_AGENT_MESSAGE: "send_agent_message",
  GET_REMOTE_ACCESS: "get_remote_access",
  START_REMOTE_ACCESS: "start_remote_access",
  STOP_REMOTE_ACCESS: "stop_remote_access",
  GENERATE_BUG_REPORT: "generate_bug_report",
} as const;

export type ActivityKind =
  | "prompt"
  | "reasoning"
  | "tool_start"
  | "tool_result"
  | "response"
  | "status"
  | "error";

export interface ActivityEvent {
  sequence: number;
  agentId: string;
  timestamp: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  status: import("./agent").Status;
}

export interface RemoteAccessInfo {
  running: boolean;
  url: string | null;
  token: string;
}

// Tauri invoke command return types
export interface AppStats {
  totalAgents: number;
  activeAgents: number;
  totalTokensIn: number;
  totalTokensOut: number;
  uptimeSeconds: number;
}
