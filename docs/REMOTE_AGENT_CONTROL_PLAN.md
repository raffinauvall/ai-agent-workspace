# OfficeAI Remote Agent Control Plan

> Update implementasi 2026-10-01: lihat [Office upgrade plan](OFFICE_UPGRADE_PLAN.md)
> untuk baseline, upgrade GLB, verified Kitty/tmux attach, composer capability-driven,
> dan hasil verifikasi terbaru. Bagian kondisi awal di bawah adalah baseline historis,
> bukan status aplikasi saat ini. Screen/PTY umum dan hardening production belum
> dinyatakan tersedia hanya karena tercantum sebagai target di dokumen ini.

## 1. Tujuan

OfficeAI akan menjadi control plane lokal untuk agent AI yang berjalan di laptop. Desktop dan aplikasi Flutter memakai sumber data yang sama untuk:

- melihat kantor 3D dan semua agent yang sedang berjalan;
- memilih karakter agent untuk membuka detail;
- melihat tujuan, aktivitas sekarang, dan timeline agent;
- mengirim prompt dari HP ke agent yang dikelola OfficeAI;
- membuka agent baru dari HP;
- membuka window terminal nyata di laptop ketika agent baru dibuat;
- menambahkan karakter baru ke kantor desktop dan mobile setelah proses agent terdeteksi.

Fitur remote hanya bekerja ketika laptop menyala, OfficeAI berjalan, dan tunnel aktif.

## 2. Kondisi Saat Ini

Bagian yang sudah tersedia:

- Desktop memakai `ThreeOfficeScene` dan sudah memiliki raycasting untuk memilih agent.
- `AgentSidebar.svelte` sudah menampilkan metadata agent.
- Rust sudah menemukan proses agent dan membaca log Codex, Claude, Gemini, Cursor, serta Windsurf.
- Agent Registry sudah mengirim event `agent:found`, `agent:lost`, dan `agent:state-changed` ke desktop.
- Flutter sudah bisa membaca `/api/agents` dan `/api/stats` melalui Cloudflare Tunnel.
- Flutter sudah memiliki detail bottom sheet dasar.
- Kitty dan Codex tersedia di laptop pengembangan.

Keterbatasan yang harus diperbaiki:

- Remote API masih read-only.
- Remote API masih memakai parser HTTP manual.
- Mini log desktop hanya mencatat perubahan status di frontend, bukan aktivitas asli dari parser backend.
- `currentTask` dipakai untuk beberapa arti sekaligus, termasuk prompt, respons, dan tool.
- Kantor di Flutter masih berupa `CustomPainter` 2D dan tidak bisa memilih karakter langsung.
- Agent yang dibuka manual dari terminal tidak bisa dikontrol hanya berdasarkan PID.
- Quick Tunnel saat ini cocok untuk development, bukan remote control harian.

## 3. Keputusan Teknis

| Area | Keputusan v1 | Alasan |
|---|---|---|
| Sumber data | Rust backend OfficeAI | Desktop dan mobile harus melihat state yang sama |
| Terminal | Kitty remote control melalui Unix socket | Kitty sudah tersedia dan dapat membuka window serta menerima input |
| Agent yang dapat dikontrol | Agent managed dan agent existing yang berhasil di-attach | Semua agent writable tanpa mengarang akses dari PID saja |
| Existing agent | Attach ke Kitty, tmux, screen, atau PTY yang cocok | Agent tetap bisa menerima prompt tanpa dibuat ulang |
| Mobile 3D | Reuse Three.js melalui local WebView bundle | Menghindari dua renderer yang akan berbeda |
| Mobile UI | Flutter native untuk sheet, form, error, dan command composer | Keyboard, safe area, dan accessibility lebih mudah dikendalikan |
| Sinkronisasi | Polling satu sampai dua detik | Cukup untuk skala personal dan lebih sederhana daripada socket |
| Activity history | Ring buffer di memory | Belum ada kebutuhan history lintas restart |
| Remote HTTP | Router HTTP kecil dengan JSON body handling | Endpoint write tidak layak memakai parser HTTP manual |
| Security edge | Named Cloudflare Tunnel + Cloudflare Access | Remote API dapat menjalankan proses dan menulis ke terminal |

Tidak dibuat pada v1:

- database history;
- terminal emulator di dalam Flutter;
- endpoint raw shell;
- renderer kantor native Dart;
- abstraction terminal lintas OS dengan satu implementasi;
- recovery otomatis managed session setelah OfficeAI restart;
- WebSocket atau SSE.

## 4. Arsitektur Target

```text
Flutter Mobile
  local Three.js scene + native Flutter controls
                 |
        HTTPS + Cloudflare Access
                 |
             cloudflared
                 |
      OfficeAI Remote API on localhost
                 |
  +--------------+----------------+
  |              |                |
Agent Registry  Activity Store  Managed Sessions
  |              |                |
process scan   parsed logs     Kitty Unix socket
  |              |                |
  +--------------+----------------+
                 |
       Codex / Claude / Gemini CLI

Desktop Svelte accesses the same services through Tauri IPC.
```

Backend service functions harus dipakai bersama oleh Tauri commands dan Remote API. Desktop tidak perlu memanggil HTTP localhost.

## 5. Model Data

### 5.1 AgentState

Pertahankan field yang sudah ada untuk kompatibilitas. Tambahkan:

```typescript
type ControlMode = "managed" | "attached";

interface AgentState {
  // Existing fields remain unchanged.
  currentGoal: string | null;
  currentActivity: string | null;
  controlMode: ControlMode;
  workspaceLabel: string | null;
  managedSessionId: string | null;
}
```

Aturan field:

- `currentTask` tetap tersedia selama transisi kompatibilitas.
- `currentGoal` hanya berubah ketika parser menerima prompt user yang nyata.
- `currentActivity` berubah ketika agent mulai reasoning, merespons, memakai tool, menunggu sub-agent, atau error.
- Path absolut tidak dikirim ke mobile. Mobile hanya menerima `workspaceLabel`.
- `managedSessionId` tidak boleh dipakai sebagai credential.
- `controlMode = "managed"` berarti agent dibuat oleh OfficeAI.
- `controlMode = "attached"` berarti agent sudah berjalan dan OfficeAI berhasil
  menemukan transport terminal/PTY yang dapat ditulis.
- Semua agent yang tampil sebagai controllable wajib memiliki salah satu mode di
  atas. Tidak ada mode read-only untuk agent yang berhasil dideteksi.

TypeScript tetap menjadi source of truth untuk struktur frontend. Struct Rust yang mencerminkan tipe ini harus diperbarui pada perubahan yang sama.

### 5.2 ActivityEvent

```typescript
type ActivityKind =
  | "prompt"
  | "reasoning"
  | "tool_start"
  | "tool_result"
  | "response"
  | "status"
  | "error";

interface ActivityEvent {
  sequence: number;
  agentId: string;
  timestamp: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  status: Status;
}
```

Activity Store menyimpan event per agent dalam `VecDeque`. Batas awal adalah 200 event per agent. Event lama dibuang dari depan ketika batas tercapai.

Activity yang dikirim ke mobile harus:

- berasal dari field parser, bukan raw JSONL;
- dipotong pada batas panjang yang konsisten;
- menghapus nilai `Authorization`, bearer token, API key, dan environment secret yang umum;
- tidak mengirim full tool output pada v1;
- tetap cukup detail untuk menjawab agent sedang mengerjakan apa.

Contoh timeline:

```text
21:10  Prompt       Perbaiki checkout dan jalankan test
21:11  Tool         exec_command: npm test
21:12  Tool result  Command selesai dengan exit code 1
21:12  Reasoning    Menganalisis test yang gagal
21:13  Response     Menjelaskan root cause dan perubahan
```

### 5.3 ManagedSession

```rust
struct ManagedSession {
    session_id: String,
    agent_id: Option<String>,
    provider: Provider,
    workspace_id: String,
    kitty_pid: Option<u32>,
    kitty_window_id: Option<u64>,
    cli_pid: Option<u32>,
    socket_path: PathBuf,
    state: ManagedSessionState,
    queued_message: Option<String>,
}
```

`queued_message` hanya menyimpan satu prompt. Mobile tidak boleh menumpuk antrean panjang tanpa melihat hasil agent sebelumnya.

## 6. Membuka Agent Baru

### 6.1 Request dari mobile

Mobile mengirim:

```json
{
  "provider": "codex",
  "workspaceId": "office-ai",
  "initialMessage": "Periksa failing test dan perbaiki root cause"
}
```

Mobile tidak mengirim executable path atau filesystem path.

### 6.2 Validasi backend

Backend harus:

1. memastikan remote control sedang diaktifkan pada desktop;
2. memastikan provider ada dalam enum yang didukung;
3. menemukan executable provider dari konfigurasi desktop;
4. memastikan workspace ID ada dalam allowlist;
5. melakukan canonicalization workspace dan menolak path di luar allowlist;
6. membatasi panjang initial message;
7. membuat session ID acak;
8. membuat direktori runtime privat dengan permission `0700`;
9. menyiapkan Unix socket unik untuk session.

### 6.3 Membuka terminal Kitty

OfficeAI menjalankan Kitty dengan argument terpisah. Jangan memakai `sh -c` atau membangun command string.

Konsep invocation:

```text
kitty
  --detach
  --working-directory <validated-workspace>
  --title "OfficeAI Codex - <workspace-label>"
  --listen-on unix:<private-runtime-dir>/<session-id>.sock
  --override allow_remote_control=socket-only
  <absolute-provider-executable>
```

Setiap managed agent mendapat satu OS window Kitty dan satu socket privat. OfficeAI menyimpan socket, Kitty PID, dan window ID yang dikembalikan oleh Kitty remote control.

OfficeAI memakai `kitten @ --to <socket> ls` untuk:

- memastikan terminal hidup;
- mengambil window ID;
- mengambil foreground process PID;
- menghubungkan session dengan PID Codex yang ditemukan Agent Registry.

### 6.4 Agent masuk ke kantor

Urutannya:

1. Remote API mengembalikan `sessionId` dan state `starting`.
2. Kitty membuka window terminal nyata di laptop.
3. Kitty menjalankan Codex pada workspace yang dipilih.
4. Process Scanner menemukan PID Codex.
5. Managed Session Manager menghubungkan PID tersebut dengan session.
6. Agent Registry menjalankan `register`.
7. Desktop menerima `agent:found` dan membuat karakter.
8. Mobile melihat agent pada polling berikutnya dan membuat karakter yang sama.
9. Initial message dikirim setelah foreground Codex terdeteksi.

Jika user menutup terminal, socket tidak lagi dapat dihubungi dan proses Codex hilang. Session berubah menjadi `closed`, Registry menghapus agent, dan karakter keluar dari kantor.

Jika OfficeAI ditutup tetapi terminal tetap hidup, Codex tidak dibunuh. Saat OfficeAI dibuka lagi, Existing Agent Attacher mencocokkan PID, workspace, provider, dan transport terminal untuk memulihkan session `attached`. Jika belum bisa di-attach, UI menampilkan `Attach terminal` beserta alasan dan langkah pemulihan; tidak ada mode `monitor_only`.

## 7. Mengirim Prompt dari HP

### 7.1 Mode pengiriman

```typescript
type SendMode = "now" | "queue" | "interrupt";
```

- `now`: hanya diterima ketika agent idle atau task complete.
- `queue`: simpan satu prompt dan kirim setelah task sekarang selesai.
- `interrupt`: kirim Ctrl+C, tunggu agent kembali siap, lalu kirim prompt baru. UI wajib meminta konfirmasi.

### 7.2 Pengiriman ke Kitty

Backend melakukan langkah berikut:

1. pastikan agent memiliki control session (`managed` atau `attached`);
2. pastikan socket dan target window masih hidup;
3. targetkan exact Kitty window ID, bukan title;
4. kirim prompt lewat stdin ke `kitten @ send-text --stdin`;
5. kirim Enter lewat `kitten @ send-key enter`;
6. catat event `prompt` pada Activity Store;
7. biarkan log watcher memperbarui status dan aktivitas berikutnya.

Prompt tidak boleh menjadi argument shell. Backend tidak menyediakan endpoint untuk menjalankan shell command langsung.

### 7.3 Perilaku UI

Composer menampilkan state berikut:

- `Send instruction` ketika agent siap;
- `Queue after current` ketika agent sibuk;
- `Interrupt and send` sebagai secondary destructive action;
- `Attach terminal` ketika agent existing belum punya control session;
- `Laptop offline` ketika API tidak dapat dijangkau.

## 8. Activity Pipeline

### 8.1 Parser

Perluas `ParsedEvent` dengan data aktivitas yang sudah dinormalisasi:

```rust
pub struct ParsedActivity {
    pub kind: ActivityKind,
    pub title: String,
    pub detail: Option<String>,
}

pub struct ParsedEvent {
    // Existing fields remain.
    pub activity: Option<ParsedActivity>,
}
```

Per provider:

- Codex `user_message` menjadi `prompt`.
- Codex `function_call` menjadi `tool_start` dengan nama tool dan ringkasan argument aman.
- Codex `function_call_output` menjadi `tool_result` tanpa full output.
- Codex `agent_reasoning` menjadi `reasoning`.
- Codex `agent_message` menjadi `response`.
- Claude `tool_use` mengambil nama tool dan ringkasan input.
- Claude `tool_result` menjadi completion event.
- Gemini `tool_calls` mengambil nama function dan ringkasan argument.
- IDE parser yang tidak memiliki detail cukup tetap mengirim status generik yang jujur.

### 8.2 Consumer

Log consumer melakukan dua update dari satu parsed event:

1. memperbarui Agent Registry untuk current state;
2. menambahkan event ke Activity Store.

Desktop dan mobile tidak membuat activity history sendiri.

## 9. API Contract

Gunakan prefix `/api/v1` untuk endpoint baru.

### 9.1 Read endpoints

```text
GET /api/v1/health
GET /api/v1/agents
GET /api/v1/stats
GET /api/v1/agents/:id/activities?after=<sequence>&limit=<limit>
GET /api/v1/capabilities
```

`/capabilities` mengembalikan:

- provider yang terpasang;
- terminal controller yang tersedia;
- workspace ID dan label;
- apakah remote control sedang aktif;
- fitur yang didukung agent tertentu.

### 9.2 Write endpoints

```text
POST /api/v1/agents
POST /api/v1/agents/:id/messages
```

Body untuk message:

```json
{
  "message": "Lanjutkan implementasi dan jalankan test yang relevan",
  "mode": "queue"
}
```

### 9.3 Response status

```text
200 request berhasil
201 managed agent dibuat
400 body atau field tidak valid
401 credential tidak valid
403 remote control mati atau capability tidak tersedia
404 agent atau workspace tidak ditemukan
409 agent sibuk, session tertutup, atau queue sudah terisi
413 body terlalu besar
429 rate limit tercapai
500 kegagalan internal yang sudah dicatat di desktop log
```

Error response selalu memakai bentuk yang sama:

```json
{
  "error": "agent_busy",
  "message": "Agent masih mengerjakan task. Queue atau interrupt task tersebut."
}
```

## 10. Security Model

Remote write access berarti remote code execution tidak langsung, karena agent dapat memakai shell dan mengubah file. Security tidak boleh diturunkan menjadi sekadar URL acak.

### 10.1 Network boundary

- Backend tetap bind ke `127.0.0.1`.
- `cloudflared` menjadi satu-satunya jalur dari internet.
- Quick Tunnel hanya dipakai selama development.
- Daily use memakai named Cloudflare Tunnel.
- Cloudflare Access memeriksa service token perangkat mobile.
- Bearer token OfficeAI tetap dipakai sebagai lapisan kedua.
- Origin menolak request tanpa kedua credential.

### 10.2 Credential handling

- Flutter menyimpan credential di Android Keystore atau iOS Keychain.
- Jangan menyimpan secret di plain shared preferences.
- Token dapat dicabut dari desktop.
- Remote control kembali `off` setiap OfficeAI restart.
- UI desktop harus menunjukkan kapan control mode aktif.
- Jangan menulis token atau prompt lengkap ke app log.

### 10.3 Command boundary

- Tidak ada endpoint raw shell.
- Provider adalah enum.
- Workspace berasal dari allowlist desktop.
- Executable path berasal dari desktop config.
- Message mempunyai size limit.
- Create agent dan send message mempunyai rate limit.
- Mode `interrupt` memerlukan konfirmasi eksplisit.
- Agent tanpa control session menolak write operation dan meminta attach;
- Agent `managed` dan `attached` punya write access yang sama;
- Attach hanya boleh menulis ke transport yang cocok dengan PID dan workspace;
- Tidak ada endpoint raw shell, walaupun agent memakai mode `attached`.

### 10.4 CORS

Native Flutter tidak membutuhkan `Access-Control-Allow-Origin: *`. Scene WebView menerima data melalui Flutter JavaScript bridge, bukan mengambil Remote API langsung. Hilangkan wildcard CORS dari remote write server.

## 11. Desktop UX

### 11.1 Agent selection

Pertahankan raycasting `ThreeOfficeScene` yang sudah ada. Perbesar invisible hit geometry tanpa mengubah ukuran visual karakter.

Keyboard fallback tetap tersedia melalui daftar agent. Memilih row agent harus membuka sidebar yang sama seperti klik karakter.

### 11.2 Agent sidebar

Urutan konten:

1. nama, model, tier, dan status;
2. workspace;
3. current goal;
4. current activity;
5. activity timeline;
6. command composer untuk semua agent dengan control session;
7. tombol `Attach terminal` untuk agent existing;
8. alasan attach gagal dan langkah pemulihan yang bisa dilakukan user.

Timeline memiliki loading, empty, dan error state. Warna status selalu disertai label teks.

### 11.3 New Agent dialog

Field minimum:

- provider;
- workspace;
- initial instruction opsional;
- tombol `Open terminal and start`.

Provider yang tidak terpasang tidak ditampilkan sebagai action aktif. Dialog menampilkan hasil capability check nyata.

Progress:

```text
Opening terminal
Starting Codex
Connecting agent
Agent joined the office
```

Setiap state harus berasal dari backend lifecycle, bukan timer dekoratif.

## 12. Mobile UX

### 12.1 Design direction

Reading this as: personal developer control room dengan visual language kantor 3D OfficeAI, dial ENERGY 2 / RHYTHM 2 / MOTION 2.

Alasan keputusan visual:

- kantor 3D menjadi focal point karena karakter adalah cara utama memilih agent;
- dark theme mengikuti desktop developer tool yang sudah ada;
- gold tetap menjadi accent untuk primary control dan selected agent;
- surface solid dipakai agar teks tetap terbaca di atas scene bergerak;
- motion hanya menunjukkan perpindahan agent, selection, dan state transition;
- status memakai warna, label, dan ikon agar tidak bergantung pada warna saja.

### 12.2 Home

Home terdiri dari:

- compact connection state;
- kantor 3D yang memakai ruang utama;
- tombol `New agent` dengan touch target minimal 44 x 44;
- expandable agent tray sebagai alternatif karakter kecil;
- state loading, empty office, authentication error, dan laptop offline.

Tidak perlu bottom navigation pada v1 karena aplikasi hanya memiliki satu pekerjaan utama: melihat dan mengendalikan office.

### 12.3 Agent detail sheet

Tap karakter atau agent row membuka `DraggableScrollableSheet`:

```text
Agent name and status
Workspace and model
Current goal
Now
Activity timeline
Send instruction composer
```

Composer harus tetap terlihat di atas keyboard dengan `SafeArea` dan resize behavior yang benar.

### 12.4 New Agent sheet

Field minimum:

- provider yang tersedia;
- workspace allowlist;
- initial instruction;
- tombol `Open terminal and start`.

Setelah submit, sheet menunjukkan backend lifecycle. Ketika agent sudah terhubung, sheet dapat membuka detail agent tersebut dan scene menyorot karakter barunya.

## 13. Shared Three.js Scene

Jangan port scene ke Dart.

Perubahan minimum pada `ThreeOfficeScene`:

- tambahkan external-data mode;
- tambahkan public `syncAgents(agents)`;
- terima callback agent selection;
- pertahankan Tauri subscription sebagai default desktop mode;
- perbesar hit area untuk touch;
- izinkan renderer menurunkan pixel ratio pada perangkat mobile.

Tambahkan Vite entry kecil untuk scene mobile. Build output dimasukkan sebagai Flutter asset. Flutter memuatnya dengan `webview_flutter`.

Bridge contract:

```text
Flutter -> JavaScript: sync agent snapshot
JavaScript -> Flutter: agentSelected(agentId)
JavaScript -> Flutter: sceneReady
JavaScript -> Flutter: sceneError(message)
```

Agent JSON harus diserialisasi dengan `jsonEncode`, bukan string concatenation.

Flutter tetap memegang network credential. JavaScript scene tidak menerima bearer token atau Cloudflare secret.

## 14. Flutter Structure

Jangan menambahkan state-management framework pada v1. `StatefulWidget`, `ValueNotifier`, atau `ChangeNotifier` cukup untuk satu screen.

Pembagian file minimum:

```text
mobile/lib/main.dart
mobile/lib/models.dart
mobile/lib/office_api.dart
mobile/lib/office_scene.dart
mobile/lib/agent_detail_sheet.dart
```

Dependency baru yang dibenarkan:

- `webview_flutter` untuk shared scene;
- secure storage package untuk credential platform storage.

Pilih versi yang kompatibel dengan Flutter dan Dart SDK repo saat implementasi. Jangan menaikkan SDK hanya untuk mengambil versi dependency terbaru jika versi kompatibel masih tersedia.

## 15. Backend Structure

Tambahkan hanya dua module utama:

```text
src-tauri/src/activity.rs
src-tauri/src/managed_sessions.rs
```

Jangan membuat `TerminalBackend` trait pada v1 karena hanya Kitty yang didukung. Extract interface setelah ada terminal kedua.

File utama yang berubah:

```text
src-tauri/src/models/agent_state.rs
src-tauri/src/interceptor/parsed_event.rs
src-tauri/src/interceptor/*_parser.rs
src-tauri/src/ipc/commands.rs
src-tauri/src/ipc/remote_api.rs
src-tauri/src/lib.rs
src/lib/types/agent.ts
src/lib/types/events.ts
src/lib/stores/agents.svelte.ts
src/lib/ui/AgentSidebar.svelte
src/App.svelte
src/lib/renderer/ThreeOfficeScene.ts
mobile/lib/*
```

## 16. Implementation Phases

### Phase 0: Baseline

- Jalankan Rust, TypeScript, dan Flutter checks yang sudah ada.
- Catat kegagalan baseline sebelum mengubah fitur.
- Jangan menimpa perubahan mobile dan workflow yang sudah ada di worktree.
- Tambahkan test fixture hanya ketika logic baru memerlukannya.

Gate: baseline terdokumentasi dan perubahan user tetap utuh.

### Phase 1: Activity model

- Tambahkan `ActivityEvent` dan Activity Store.
- Pisahkan current goal dari current activity.
- Perluas parser Codex terlebih dahulu.
- Hubungkan log consumer ke Activity Store.
- Tambahkan Tauri command untuk membaca activity.
- Ganti fake sidebar log dengan backend activity.

Gate: klik Codex di desktop menunjukkan prompt, tool, dan response yang berasal dari log asli.

### Phase 2: Managed Kitty session

- Tambahkan capability detection untuk Kitty, kitten, Codex, tmux, dan PTY transport.
- Tambahkan workspace allowlist.
- Implementasikan create session dengan socket privat.
- Ambil Kitty window ID dan foreground CLI PID.
- Hubungkan managed session dengan Agent Registry.
- Implementasikan Existing Agent Attacher berdasarkan PID, process tree, cwd,
  provider, dan transport terminal yang sedang berjalan.
- Pulihkan session `attached` setelah OfficeAI restart.
- Implementasikan send now, queue, dan interrupt.
- Pastikan terminal nyata terbuka di laptop.

Gate: New Agent dari desktop membuka Kitty, menjalankan Codex, dan menambahkan karakter baru ke kantor.

### Phase 3: Remote API write support

- Pindahkan remote API ke router HTTP dengan body parsing yang benar.
- Tambahkan versioned endpoints.
- Tambahkan validation, auth, rate limit, dan consistent errors.
- Hilangkan wildcard CORS.
- Tambahkan remote control session toggle.
- Pertahankan endpoint read lama selama transisi Flutter.

Gate: API integration test dapat mengirim prompt ke managed dan attached agent tanpa endpoint shell.

### Phase 4: Desktop control UX

- Tambahkan New Agent button dan dialog.
- Tambahkan real activity timeline.
- Tambahkan command composer.
- Tambahkan attach state dan recovery state.
- Tambahkan queue dan interrupt confirmation.
- Pastikan semua control dapat dipakai dengan keyboard.

Gate: seluruh local desktop workflow selesai sebelum mobile write access dibuka.

### Phase 5: Mobile 3D

- Refactor `ThreeOfficeScene` untuk external-data mode.
- Buat mobile Vite entry dan Flutter asset build step.
- Tambahkan WebView serta JavaScript bridge.
- Sinkronkan agent snapshot dari Flutter.
- Hubungkan character tap ke Flutter detail sheet.
- Tambahkan fallback agent tray.

Gate: mobile menampilkan kantor Three.js yang sama dan karakter dapat disentuh.

### Phase 6: Mobile control UX

- Tambahkan secure credential storage.
- Tambahkan capabilities load.
- Tambahkan detail activity polling saat sheet terbuka.
- Tambahkan composer dan send mode.
- Tambahkan New Agent sheet.
- Tampilkan lifecycle sampai karakter muncul.
- Tambahkan offline, auth error, empty, dan loading states.

Gate: HP dapat membuat Codex baru, melihat terminal terbuka di laptop, memilih karakter, dan mengirim prompt berikutnya.

### Phase 7: Cloudflare release hardening

- Konfigurasikan named tunnel.
- Lindungi app dengan Cloudflare Access.
- Simpan service credential hanya di secure storage.
- Uji revocation dan token rotation.
- Uji tunnel mati, laptop sleep, dan OfficeAI restart.
- Dokumentasikan pairing perangkat.

Gate: Quick Tunnel tidak dipakai untuk daily remote control.

## 17. Testing Plan

### 17.1 Rust unit tests

- ring buffer mempertahankan urutan dan batas;
- activity cursor `after` tidak mengulang event;
- redaction menghapus credential patterns;
- provider command memakai argv terpisah;
- workspace canonicalization menolak traversal dan symlink escape;
- monitor-only agent menolak message;
- busy agent menerapkan mode yang benar;
- queue kedua ditolak ketika slot queue terisi;
- auth dan body-size validation bekerja;
- managed session cleanup tidak membunuh agent tanpa instruksi eksplisit.

### 17.2 Parser tests

- Codex prompt;
- Codex tool start dan result;
- Codex reasoning dan response;
- Claude tool name dan safe summary;
- Gemini tool call;
- unsupported detail menghasilkan honest generic activity.

### 17.3 Desktop tests

- klik karakter membuka agent yang benar;
- pilih agent dari list membuka sidebar yang sama;
- timeline berasal dari backend;
- command composer disabled untuk monitor-only;
- New Agent dialog hanya menampilkan capability nyata;
- Escape menutup dialog dan sidebar;
- empty, loading, dan error state terlihat.

### 17.4 Flutter tests

- connect dan invalid credential;
- offline state;
- scene-ready bridge;
- agentSelected membuka sheet yang benar;
- activity timeline update;
- managed dan monitor-only composer state;
- New Agent validation;
- keyboard tidak menutupi composer;
- secure credential load dan delete.

### 17.5 Manual end-to-end

1. Aktifkan remote control di desktop.
2. Hubungkan Android melalui Cloudflare Access.
3. Pilih New Agent, Codex, dan workspace OfficeAI.
4. Pastikan Kitty window baru muncul di laptop.
5. Pastikan Codex berjalan pada workspace yang dipilih.
6. Pastikan karakter baru muncul di desktop.
7. Pastikan karakter yang sama muncul di mobile.
8. Tap karakter dan cocokkan current goal serta current activity dengan terminal.
9. Kirim prompt dari HP dan pastikan teks muncul di terminal yang benar.
10. Queue prompt ketika agent sibuk.
11. Uji interrupt dengan confirmation.
12. Tutup terminal dan pastikan karakter keluar.
13. Matikan tunnel dan pastikan mobile menampilkan offline state.
14. Cabut credential dan pastikan request berikutnya ditolak.

## 18. Acceptance Criteria

Fitur selesai ketika semua kondisi berikut terpenuhi:

- New Agent dari HP membuka OS window Kitty yang terlihat di laptop.
- Provider yang dipilih berjalan di workspace yang dipilih.
- Codex baru otomatis muncul sebagai karakter di desktop dan mobile.
- Klik atau tap karakter membuka detail agent yang sama.
- Detail menunjukkan current goal dan aktivitas aktual.
- Timeline berasal dari backend parser, bukan status buatan frontend.
- Prompt dari HP muncul pada terminal Codex yang tepat.
- Agent menjalankan prompt dan status berikutnya tersinkron ke kedua UI.
- Queue mengirim satu prompt setelah task selesai.
- Interrupt meminta konfirmasi dan menargetkan agent yang benar.
- Agent existing yang berhasil di-attach tetap terlihat dan dapat dikontrol penuh.
- Agent yang belum punya transport terminal yang bisa di-attach menampilkan alasan attach gagal dan tombol pemulihan.
- Tidak ada endpoint raw shell.
- Workspace di luar allowlist ditolak.
- Secret tidak masuk ke scene JavaScript, app log, atau plain preferences.
- Laptop atau tunnel offline menghasilkan error yang bisa dipahami.
- Desktop dan mobile memiliki loading, empty, dan error states.
- Semua target sentuh mobile minimal 44 x 44.
- Build Rust, Svelte, Flutter, unit tests, dan end-to-end flow lulus.

## 19. Known Limits

v1 menargetkan Linux dan Kitty karena itu environment yang tersedia sekarang.

Tambahkan dukungan terminal lain hanya ketika ada target nyata:

- macOS Terminal atau iTerm2;
- Windows Terminal;
- GNOME Terminal;
- terminal multiplexer seperti tmux.

Jika OfficeAI restart, terminal yang masih hidup dicoba di-attach kembali berdasarkan PID, workspace, provider, dan transport terminal. Jika transport belum bisa dipulihkan, UI meminta attach ulang; tidak ada mode monitor-only.

Polling tetap digunakan sampai profiling menunjukkan traffic atau latency menjadi masalah. Database tetap ditunda sampai history lintas restart benar-benar dibutuhkan.

## 20. Delivery Checklist

Sebelum menandai fitur selesai:

- jalankan `npm test`;
- jalankan `npm run check`;
- jalankan Rust tests dan clippy;
- jalankan Flutter analyze dan widget tests;
- build desktop;
- build Android;
- periksa console dan app log;
- klik setiap desktop control;
- tap setiap mobile control;
- uji setiap error state;
- uji keyboard-only desktop flow;
- uji mobile dengan keyboard terbuka;
- catat hasil end-to-end dari create agent sampai prompt kedua selesai.

## 21. References

Current implementation:

- [Remote API](../src-tauri/src/ipc/remote_api.rs)
- [Tauri commands](../src-tauri/src/ipc/commands.rs)
- [Agent state model](../src-tauri/src/models/agent_state.rs)
- [Parsed event model](../src-tauri/src/interceptor/parsed_event.rs)
- [Desktop Three.js scene](../src/lib/renderer/ThreeOfficeScene.ts)
- [Desktop agent sidebar](../src/lib/ui/AgentSidebar.svelte)
- [Flutter companion](../mobile/lib/main.dart)

External documentation:

- [Kitty remote control](https://sw.kovidgoyal.net/kitty/remote-control/)
- [Kitty command-line invocation](https://sw.kovidgoyal.net/kitty/invocation/)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Flutter WebView](https://pub.dev/packages/webview_flutter)
