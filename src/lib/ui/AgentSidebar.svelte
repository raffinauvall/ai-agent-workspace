<script lang="ts">
  import type { ActivityEvent, Status } from "$lib/types/index";
  import {
    getSelectedAgent,
    isSidebarOpen,
    deselectAgent,
  } from "$lib/stores/index.svelte";
  import {
    statusColor,
    statusLabel,
    tierColor,
    formatTokens,
    formatUptime,
    truncate,
    uptimeFromLastActivity,
  } from "./utils";
  import { t } from "$lib/i18n/index";
  import MiniLog from "./MiniLog.svelte";
  import type { ControlCapability } from "$lib/types/agent";

  // Log entry type for mini log
  interface LogEntry {
    timestamp: Date;
    status: Status;
    message: string;
  }

  // Reactive values from stores
  const agent = $derived(getSelectedAgent());
  const open = $derived(isSidebarOpen());
  // Log history — accumulated per agent session
  let logHistory = $state<LogEntry[]>([]);
  let lastAgentId = $state<string | null>(null);
  let lastStatus = $state<Status | null>(null);
  let activities = $state<ActivityEvent[]>([]);
  let activityError = $state("");
  let message = $state("");
  let sending = $state(false);
  let control = $state<ControlCapability | null>(null);
  let receipt = $state("");

  // Track status changes to build mini log
  $effect(() => {
    const currentAgent = agent;
    if (!currentAgent) return;

    // Reset log when switching agents
    if (currentAgent.id !== lastAgentId) {
      logHistory = [
        {
          timestamp: new Date(),
          status: currentAgent.status,
          message: `${t("sidebar.statusPrefix")} ${statusLabel(currentAgent.status)}`,
        },
      ];
      lastAgentId = currentAgent.id;
      lastStatus = currentAgent.status;
      return;
    }

    // Append log entry when status changes
    if (currentAgent.status !== lastStatus) {
      logHistory = [
        ...logHistory,
        {
          timestamp: new Date(),
          status: currentAgent.status,
          message: `${t("sidebar.statusChanged")} ${statusLabel(currentAgent.status)}`,
        },
      ];
      lastStatus = currentAgent.status;
    }
  });

  $effect(() => {
    const id = agent?.id;
    if (!id) return;
    activities = [];
    activityError = "";
    control = null;
    message = "";
    receipt = "";
    let cancelled = false;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const [events, capability] = await Promise.all([
          invoke<ActivityEvent[]>("get_agent_activities", { id, after: 0, limit: 50 }),
          invoke<ControlCapability>("get_agent_control", { id }),
        ]);
        if (!cancelled) { activities = events; control = capability; }
      } catch (error) {
        if (!cancelled) activityError = String(error);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
    return () => { cancelled = true; clearInterval(timer); };
  });

  async function sendInstruction(mode: "now" | "queue" | "interrupt"): Promise<void> {
    if (!agent || !control?.canSend || !message.trim() || sending) return;
    const target = agent.id;
    if (mode === "interrupt" && !window.confirm("Interrupt task agent ini dan kirim prompt baru?")) return;
    sending = true;
    activityError = "";
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("send_agent_message", { id: target, message: message.trim(), mode });
      if (agent?.id === target) {
        message = "";
        receipt = mode === "queue" && agent.status !== "idle" && agent.status !== "task_complete"
          ? "Antrean tersimpan. Menunggu task selesai." : "Dikirim ke terminal. Tunggu aktivitas agent.";
      }
    } catch (error) {
      activityError = error instanceof Error ? error.message : String(error);
    } finally {
      sending = false;
    }
  }

  // Live session duration counter (from startedAt)
  let sessionSec = $state(0);

  $effect(() => {
    const currentAgent = agent;
    if (!currentAgent) {
      sessionSec = 0;
      return;
    }
    sessionSec = uptimeFromLastActivity(currentAgent.startedAt);
    const interval = setInterval(() => {
      sessionSec = uptimeFromLastActivity(currentAgent.startedAt);
    }, 5000);
    return () => clearInterval(interval);
  });

  // Keyboard: close on Escape
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && open) {
      deselectAgent();
    }
  }

  // Close sidebar when clicking empty space on canvas
  function onDeselectAgent(): void {
    deselectAgent();
  }

  $effect(() => {
    window.addEventListener("office:deselect-agent", onDeselectAgent);
    return () => window.removeEventListener("office:deselect-agent", onDeselectAgent);
  });

</script>

<svelte:window onkeydown={onKeydown} />

<!-- Sidebar panel -->
{#if open && agent}
  <aside
    class="sidebar panel"
    aria-label="{t('sidebar.agentDetails')} {agent.name}"
    role="region"
  >
    <!-- Header -->
    <header class="sidebar-header">
      <div class="agent-avatar" style:background={tierColor(agent.tier)}>
        {agent.name.charAt(0).toUpperCase()}
      </div>

      <div class="agent-identity">
        <h2 class="agent-name">{agent.name}</h2>
        <div class="agent-meta">
          <span
            class="tier-badge"
            style:background="color-mix(in srgb, {tierColor(agent.tier)} 20%, transparent)"
            style:color={tierColor(agent.tier)}
          >{agent.tier}</span>
          <span class="agent-role">{agent.role}</span>
        </div>
      </div>

      <button
        class="close-btn"
        aria-label={t("sidebar.closeSidebar")}
        onclick={deselectAgent}
      >&#x2715;</button>
    </header>

    <hr class="divider" />

    <!-- Status row -->
    <section class="detail-section" aria-label={t("sidebar.status")}>
      <div class="detail-label">{t("sidebar.status")}</div>
      <div class="detail-value status-row">
        <span
          class="status-indicator"
          style:background={statusColor(agent.status)}
        ></span>
        <span style:color={statusColor(agent.status)}>
          {statusLabel(agent.status)}
        </span>
      </div>
    </section>

    <!-- Model row -->
    <section class="detail-section" aria-label={t("sidebar.model")}>
      <div class="detail-label">{t("sidebar.model")}</div>
      <div class="detail-value mono">{agent.model}</div>
    </section>

    <!-- Current task row -->
    <section class="detail-section" aria-label={t("sidebar.currentTask")}>
      <div class="detail-label">{t("sidebar.currentTask")}</div>
      <div class="detail-value task-text">
        {agent.currentGoal ?? agent.currentTask ? truncate(agent.currentGoal ?? agent.currentTask ?? "", 120) : t("sidebar.idle")}
      </div>
    </section>

    <section class="detail-section">
      <div class="detail-label">Now</div>
      <div class="detail-value task-text">{agent.currentActivity ?? statusLabel(agent.status)}</div>
      {#if agent.workspaceLabel}<div class="detail-label workspace-label">Workspace · {agent.workspaceLabel}</div>{/if}
    </section>

    <!-- Tokens row -->
    <section class="detail-section" aria-label={t("sidebar.tokenUsage")}>
      <div class="detail-label">{t("sidebar.tokens")}</div>
      <div class="detail-value tokens-row">
        <span class="token-chip in">
          <span class="chip-label">IN</span>
          <span class="chip-value mono">{formatTokens(agent.tokensIn)}</span>
        </span>
        <span class="token-chip out">
          <span class="chip-label">OUT</span>
          <span class="chip-value mono">{formatTokens(agent.tokensOut)}</span>
        </span>
      </div>
    </section>

    <!-- Session row -->
    <section class="detail-section" aria-label={t("sidebar.session")}>
      <div class="detail-label">{t("sidebar.session")}</div>
      <div class="detail-value mono">{formatUptime(sessionSec)}</div>
    </section>

    <!-- PID row -->
    {#if agent.pid !== null}
      <section class="detail-section" aria-label={t("sidebar.pid")}>
        <div class="detail-label">{t("sidebar.pid")}</div>
        <div class="detail-value mono">{agent.pid}</div>
      </section>
    {/if}

    <!-- Source row -->
    <section class="detail-section" aria-label={t("sidebar.source")}>
      <div class="detail-label">{t("sidebar.source")}</div>
      <div class="detail-value">{agent.source.replace("_", " ")}</div>
    </section>

    <!-- Sub-agents section -->
    {#if agent.subAgents.length > 0}
      <section class="detail-section sub-agents-section" aria-label={t("sidebar.subAgents")}>
        <div class="detail-label">{t("sidebar.subAgents")}</div>
        <div class="detail-value">
          <div class="sub-agents-list">
            {#each agent.subAgents as sub}
              <div class="sub-agent-item">
                <span class="sub-agent-dot"></span>
                <span class="sub-agent-desc">{sub.description}</span>
              </div>
            {/each}
          </div>
        </div>
      </section>
    {/if}

    <hr class="divider" />

    <!-- Mini log -->
    <section class="log-section" aria-label={t("sidebar.recentActivity")}>
      <div class="section-title">{t("sidebar.recentActivity")}</div>
      {#if activities.length > 0}
        <div class="activity-list">
          {#each activities.slice(-8).reverse() as event}
            <div class="activity-item">
              <span class="activity-kind">{event.kind.replace("_", " ")}</span>
              <span class="activity-title">{event.title}</span>
              {#if event.detail}<span class="activity-detail">{truncate(event.detail, 100)}</span>{/if}
            </div>
          {/each}
        </div>
      {:else}
        <MiniLog entries={logHistory} />
      {/if}
      {#if activityError}<p class="activity-error">{activityError}</p>{/if}
    </section>

    {#if control?.canSend}
      <section class="composer" aria-label="Send instruction">
        <p class="control-note">{control.transport} · target terminal terverifikasi{control.queued ? " · 1 antrean" : ""}</p>
        {#if receipt}<p class="receipt" role="status">{receipt}</p>{/if}
        <textarea bind:value={message} maxlength="4000" aria-label="Prompt untuk agent" placeholder="Instruksi untuk agent ini…" rows="3"></textarea>
        <div class="composer-actions">
          <button disabled={sending || !message.trim() || !["idle", "task_complete"].includes(agent.status)} onclick={() => sendInstruction("now")}>Send</button>
          <button disabled={sending || !message.trim() || control.queued} onclick={() => sendInstruction("queue")}>Queue</button>
          <button class="danger" disabled={sending || !message.trim()} onclick={() => sendInstruction("interrupt")}>Interrupt</button>
        </div>
      </section>
    {:else}
      <div class="control-note composer">{control?.reason ?? "Memeriksa koneksi terminal…"}</div>
    {/if}

  </aside>
{/if}

<style>
  /* Sidebar panel */
  .sidebar {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 48px; /* clear status bar */
    width: 320px;
    z-index: var(--z-sidebar);
    display: flex;
    flex-direction: column;
    pointer-events: all;
    border-radius: var(--radius-md) 0 0 var(--radius-md);
    border-right: none;
    overflow: hidden;
    animation: slide-in 200ms ease forwards;
  }

  .workspace-label { margin-top: 6px; }
  .activity-list { display: grid; gap: 7px; max-height: 180px; overflow: auto; }
  .activity-item { display: grid; grid-template-columns: auto 1fr; gap: 3px 7px; font-size: 11px; }
  .activity-kind { color: var(--color-accent, #e9b949); text-transform: capitalize; }
  .activity-title { color: var(--color-text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .activity-detail { grid-column: 2; color: var(--color-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .activity-error, .control-note { color: var(--color-text-muted); font-size: 11px; }
  .receipt { color: #60d394; font-size: 11px; }
  .composer { padding: 12px 16px 16px; border-top: 1px solid var(--color-border); }
  .composer textarea { width: 100%; resize: vertical; box-sizing: border-box; background: var(--color-bg-input); color: var(--color-text-primary); border: 1px solid var(--color-border); border-radius: 8px; padding: 8px; font: inherit; }
  .composer-actions { display: flex; gap: 6px; margin-top: 8px; }
  .composer-actions button { min-height: 32px; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-bg-input); color: var(--color-text-primary); cursor: pointer; padding: 0 9px; }
  .composer-actions button:first-child { background: var(--color-accent, #e9b949); color: #16131a; }
  .composer-actions .danger { color: #ff9b9b; }
  .composer-actions button:disabled { opacity: .5; cursor: not-allowed; }

  @keyframes slide-in {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  /* Header */
  .sidebar-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    flex-shrink: 0;
  }

  .agent-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
    color: #fff;
    flex-shrink: 0;
  }

  .agent-identity {
    flex: 1;
    min-width: 0;
  }

  .agent-name {
    font-size: 15px;
    font-weight: 600;
    color: var(--color-text-primary);
    margin: 0 0 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .agent-meta {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .tier-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: capitalize;
    letter-spacing: 0.04em;
  }

  .agent-role {
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-bg-input);
    border: 1px solid var(--color-border);
    border-radius: 50%;
    color: var(--color-text-secondary);
    cursor: pointer;
    font-size: 12px;
    flex-shrink: 0;
    transition:
      background var(--transition-fast),
      color var(--transition-fast);
  }

  .close-btn:hover {
    background: var(--color-bg-hover);
    color: var(--color-text-primary);
  }

  /* Divider */
  .divider {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 0;
    flex-shrink: 0;
  }

  /* Detail sections */
  .detail-section {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 16px;
    flex-shrink: 0;
  }

  .detail-label {
    width: 90px;
    font-size: 11px;
    color: var(--color-text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding-top: 1px;
    flex-shrink: 0;
  }

  .detail-value {
    flex: 1;
    font-size: 12px;
    color: var(--color-text-primary);
    word-break: break-word;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .status-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .task-text {
    color: var(--color-text-secondary);
    line-height: 1.5;
    font-style: italic;
  }

  /* Tokens */
  .tokens-row {
    display: flex;
    gap: 8px;
  }

  .token-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border-radius: 10px;
  }

  .token-chip.in {
    background: rgba(34, 197, 94, 0.1);
  }

  .token-chip.out {
    background: rgba(74, 158, 255, 0.1);
  }

  .chip-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .token-chip.in .chip-label {
    color: var(--color-accent-green);
  }

  .token-chip.out .chip-label {
    color: var(--color-accent-blue);
  }

  .chip-value {
    font-size: 12px;
    font-weight: 600;
    color: var(--color-text-primary);
  }

  /* Log section */
  .log-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 12px 16px;
    min-height: 0;
    overflow: hidden;
  }

  .section-title {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--color-text-muted);
    margin-bottom: 8px;
    flex-shrink: 0;
  }

  /* Sub-agents */
  .sub-agents-section {
    align-items: flex-start;
  }

  .sub-agents-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 120px;
    overflow-y: auto;
  }

  .sub-agent-item {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }

  .sub-agent-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-accent-purple);
    flex-shrink: 0;
  }

  .sub-agent-desc {
    color: var(--color-text-secondary);
    word-break: break-word;
  }
</style>
