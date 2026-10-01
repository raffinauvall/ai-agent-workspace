<script lang="ts">
  import { onMount } from "svelte";
  import { initAgentsStore } from "$lib/stores/agents.svelte";
  import { initSettingsStore } from "$lib/stores/settings.svelte";
  import { selectAgent } from "$lib/stores/office.svelte";
  import { ThreeOfficeScene } from "$lib/renderer/ThreeOfficeScene";
  import { initSoundBridge, destroySoundBridge } from "$lib/sound";
  import { TAURI_COMMANDS, type RemoteAccessInfo } from "$lib/types/index";
  import AgentSidebar from "$lib/ui/AgentSidebar.svelte";
  import StatusBar from "$lib/ui/StatusBar.svelte";
  import AgentMetrics from "$lib/ui/AgentMetrics.svelte";
  import SettingsPanel from "$lib/ui/SettingsPanel.svelte";
  import { t } from "$lib/i18n/index";
  import "$lib/ui/styles.css";
  import officeMark from "../images/officeai-mark.svg";

  // Settings panel visibility
  let settingsOpen = $state(false);
  let remoteOpen = $state(false);
  let remoteBusy = $state(false);
  let remoteError = $state("");
  let remote = $state<RemoteAccessInfo | null>(null);

  // Three.js scene instance
  let scene: ThreeOfficeScene | null = null;

  // Handle keyboard shortcuts globally
  function onKeydown(event: KeyboardEvent): void {
    // Ctrl+, or Cmd+, — open settings
    if ((event.ctrlKey || event.metaKey) && event.key === ",") {
      event.preventDefault();
      settingsOpen = !settingsOpen;
    }
  }

  // Listen for agent selection events dispatched from the renderer
  function onAgentSelect(event: Event): void {
    const customEvent = event as CustomEvent<{ id: string }>;
    selectAgent(customEvent.detail.id);
  }

  async function refreshRemote(): Promise<void> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      remote = await invoke<RemoteAccessInfo>(TAURI_COMMANDS.GET_REMOTE_ACCESS);
    } catch {
      remote = null;
    }
  }

  async function toggleRemote(): Promise<void> {
    if (remoteBusy) return;
    remoteBusy = true;
    remoteError = "";
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (remote?.running) {
        await invoke(TAURI_COMMANDS.STOP_REMOTE_ACCESS);
      } else {
        remote = await invoke<RemoteAccessInfo>(TAURI_COMMANDS.START_REMOTE_ACCESS);
      }
      await refreshRemote();
    } catch (err) {
      remoteError = err instanceof Error ? err.message : String(err);
    } finally {
      remoteBusy = false;
    }
  }

  async function copyRemote(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      remoteError = "Clipboard tidak tersedia; salin nilai ini manual.";
    }
  }

  onMount(() => {
    let disposed = false;

    // Initialize stores first, then renderer (renderer reads store for mock data fallback)
    void initSettingsStore();
    void initSoundBridge();
    void refreshRemote();

    const startup = async () => {
      await initAgentsStore();

      const canvas = document.getElementById("office-canvas");
      if (!canvas) return;

      const nextScene = new ThreeOfficeScene();
      try {
        await nextScene.init(canvas);
        if (disposed) nextScene.destroy();
        else scene = nextScene;
      } catch (err) {
        nextScene.destroy();
        throw err;
      }
    };

    startup().catch((err) => {
      console.error("[App] Failed to initialize:", err);
    });

    // Register agent selection listener (emitted by the renderer)
    window.addEventListener("office:select-agent", onAgentSelect);

    return () => {
      disposed = true;
      window.removeEventListener("office:select-agent", onAgentSelect);
      destroySoundBridge();
      scene?.destroy();
      scene = null;
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Three.js canvas container — renderer mounts here -->
<div id="office-canvas" aria-label="OfficeAI visualization" role="img"></div>

<!-- UI Overlay layer — all Svelte components sit above the canvas -->
<div class="overlay-root" aria-label="UI overlay" role="region">

  <div class="office-brand"><img src={officeMark} alt="" width="38" height="38" /><div>OfficeAI<span>WORKSPACE BY NOX14</span></div></div>

  <!-- Floating HUD widgets (top-right) -->
  <div class="hud-stack">
    <AgentMetrics />
  </div>

  <!-- Settings toggle button (top-left) -->
  <button
    class="settings-trigger btn"
    aria-label={t("app.openSettings")}
    title={t("app.settingsShortcut")}
    onclick={() => (settingsOpen = true)}
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14" />
    </svg>
    {t("app.settings")}
  </button>

  <button
    class="remote-trigger btn"
    aria-expanded={remoteOpen}
    onclick={() => (remoteOpen = !remoteOpen)}
  >
    <span class:live-dot={remote?.running} class="remote-dot" aria-hidden="true"></span>
    {remote?.running ? "Remote aktif" : "Remote"}
  </button>

  {#if remoteOpen}
    <section class="remote-card" aria-label="Remote access">
      <div class="remote-heading">
        <div>
          <strong>Remote access</strong>
          <span>{remote?.running ? "Tunnel Cloudflare aktif" : "Belum terhubung"}</span>
        </div>
        <button class="icon-button" aria-label="Tutup remote access" onclick={() => (remoteOpen = false)}>×</button>
      </div>
      {#if remote?.running && remote.url}
        <label>
          URL Flutter
          <button class="copy-field" onclick={() => copyRemote(remote?.url ?? "")}>{remote.url}</button>
        </label>
        <label>
          Token
          <button class="copy-field token" onclick={() => copyRemote(remote?.token ?? "")}>{remote.token}</button>
        </label>
      {:else}
        <p>Share URL dan token ini hanya ke device yang lo percaya.</p>
      {/if}
      {#if remoteError}<p class="remote-error">{remoteError}</p>{/if}
      <button class="remote-action" disabled={remoteBusy} onclick={toggleRemote}>
        {remoteBusy ? "Menyiapkan…" : remote?.running ? "Tutup tunnel" : "Buka tunnel"}
      </button>
    </section>
  {/if}

</div>

<!-- Agent sidebar (slide-in from right) -->
<AgentSidebar />

<!-- Status bar (fixed bottom) -->
<StatusBar />

<!-- Settings panel (modal) -->
<SettingsPanel
  open={settingsOpen}
  onClose={() => (settingsOpen = false)}
/>

<style>
  :global(*, *::before, *::after) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #0a0a14;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    color: #e0e0e0;
  }

  /* PixiJS canvas fills the viewport */
  #office-canvas {
    position: fixed;
    inset: 0;
    z-index: 0;
  }

  /* HUD widgets stack — top-right */
  .hud-stack {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: var(--z-hud);
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }

  /* Settings button — top-left, always visible */
  .office-brand { position: fixed; top: 14px; left: 16px; display: flex; align-items: center; gap: 9px; color: #eff5ff; font-size: 16px; font-weight: 700; text-shadow: 0 1px 5px #17233b; }
  .office-brand span { display: block; font-size: 8px; letter-spacing: 1.4px; color: #cdd9eb; margin-top: 2px; }
  .settings-trigger {
    position: fixed;
    top: 66px;
    left: 16px;
    z-index: var(--z-hud);
    pointer-events: all;
    font-size: 12px;
  }

  .remote-trigger {
    position: fixed;
    top: 106px;
    left: 16px;
    z-index: var(--z-hud);
    pointer-events: all;
    font-size: 12px;
  }

  .remote-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #77768a;
  }

  .remote-dot.live-dot {
    background: #60d394;
  }

  .remote-card {
    position: fixed;
    top: 146px;
    left: 16px;
    z-index: var(--z-modal);
    pointer-events: all;
    width: min(360px, calc(100vw - 32px));
    padding: 14px;
    border: 1px solid #4a4863;
    border-radius: 10px;
    background: #141422;
    box-shadow: 0 12px 28px rgb(0 0 0 / 28%);
    color: #eeeef4;
  }

  .remote-heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 12px;
  }

  .remote-heading div {
    display: grid;
    gap: 3px;
  }

  .remote-heading span,
  .remote-card p {
    margin: 0;
    color: #b8b6c6;
    font-size: 12px;
    line-height: 1.45;
  }

  .icon-button,
  .copy-field,
  .remote-action {
    min-height: 44px;
    border: 0;
    font: inherit;
    cursor: pointer;
  }

  .icon-button {
    width: 44px;
    border-radius: 6px;
    background: transparent;
    color: #d6d4e0;
    font-size: 22px;
  }

  .remote-card label {
    display: grid;
    gap: 4px;
    margin-top: 12px;
    color: #aaa8bb;
    font-size: 11px;
  }

  .copy-field {
    overflow: hidden;
    padding: 8px 10px;
    border-radius: 6px;
    background: #0d0d18;
    color: #f2f1f7;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copy-field.token {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 11px;
  }

  .remote-action {
    width: 100%;
    margin-top: 14px;
    border-radius: 6px;
    background: #e9b949;
    color: #17120a;
    font-weight: 700;
  }

  .remote-action:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  .remote-error {
    margin-top: 10px !important;
    color: #ff9b9b !important;
  }

  :global(button:focus-visible) {
    outline: 2px solid #e9b949;
    outline-offset: 2px;
  }
</style>
