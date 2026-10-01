import { ThreeOfficeScene } from "../src/lib/renderer/ThreeOfficeScene";
import type { AgentState } from "../src/lib/types/agent";

const bridge = (name: string, value = ""): void => {
  const channel = (window as unknown as Record<string, { postMessage(value: string): void }>)[name];
  channel?.postMessage(value);
};

const scene = new ThreeOfficeScene();
scene.init(document.getElementById("scene")!, {
  externalData: true,
  onAgentSelected: (agentId) => bridge("agentSelected", agentId),
}).then(() => bridge("sceneReady")).catch((error: unknown) => bridge("sceneError", String(error)));

(window as unknown as { syncAgents(states: AgentState[]): void }).syncAgents = (states) => scene.syncAgents(states);
Object.assign(window, {
  resetOfficeCamera: () => scene.resetCamera(),
  focusOfficeAgent: (id: string) => scene.focusAgent(id),
  pauseOfficeScene: (paused: boolean) => scene.setPaused(paused),
  officeSceneDiagnostics: () => scene.getDiagnostics(),
});
