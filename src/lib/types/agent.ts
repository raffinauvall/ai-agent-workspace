// Agent types — source of truth for Rust mirror in src-tauri/src/models/agent_state.rs

export type Tier = "expert" | "senior" | "middle" | "junior";

export type Status =
  | "idle"
  | "walking_to_desk"
  | "thinking"
  | "responding"
  | "tool_use"
  | "collaboration"
  | "task_complete"
  | "error"
  | "offline";

export type IdleLocation =
  | "water_cooler"
  | "kitchen"
  | "sofa"
  | "meeting_room"
  | "standing_desk"
  | "desk"
  | "bathroom"
  | "hr_zone"
  | "lounge";

export type Source = "cli" | "browser_extension" | "sdk_hook" | "ide";

export type ControlMode = "managed" | "attached" | "monitor_only";

export interface ControlCapability {
  canSend: boolean;
  reason: string | null;
  transport: string | null;
  controlMode: "managed" | "attached" | "attach_required";
  queued: boolean;
  sendModes: ("now" | "queue" | "interrupt")[];
}

export interface SubAgentInfo {
  id: string;
  description: string;
}

export interface AgentState {
  id: string;
  pid: number | null;
  name: string;
  model: string;
  tier: Tier;
  role: string;
  status: Status;
  idleLocation: IdleLocation;
  currentTask: string | null;
  currentGoal?: string | null;
  currentActivity?: string | null;
  controlMode?: ControlMode;
  workspaceLabel?: string | null;
  managedSessionId?: string | null;
  tokensIn: number;
  tokensOut: number;
  subAgents: SubAgentInfo[];
  lastActivity: string; // ISO 8601
  startedAt: string; // ISO 8601 — when agent first registered in the office
  source: Source;
}
