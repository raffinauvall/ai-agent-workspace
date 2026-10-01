import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_flutter/webview_flutter.dart';

void main() => runApp(const OfficeRemoteApp());

class OfficeRemoteApp extends StatelessWidget {
  const OfficeRemoteApp({super.key});

  @override
  Widget build(BuildContext context) {
    const ink = Color(0xffe9b949);
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'OfficeAI Remote',
      theme: ThemeData(
        brightness: Brightness.dark,
        scaffoldBackgroundColor: const Color(0xff10101c),
        colorScheme: ColorScheme.fromSeed(
          seedColor: ink,
          brightness: Brightness.dark,
          surface: const Color(0xff171724),
        ),
        useMaterial3: true,
      ),
      home: const RemoteHomePage(),
    );
  }
}

class Agent {
  const Agent({
    required this.id,
    required this.name,
    required this.model,
    required this.status,
    required this.task,
    required this.goal,
    required this.activity,
    required this.controlMode,
    this.workspaceLabel,
    this.managedSessionId,
    required this.tokensOut,
    required this.tier,
    required this.subAgents,
  });
  final String id;
  final String name;
  final String model;
  final String status;
  final String? task;
  final String? goal;
  final String? activity;
  final String controlMode;
  final String? workspaceLabel;
  final String? managedSessionId;
  final int tokensOut;
  final String tier;
  final int subAgents;

  factory Agent.fromJson(Map<String, dynamic> json) => Agent(
        id: json['id'] as String? ?? json['name'] as String? ?? 'unknown',
        name: json['name'] as String? ?? 'Unnamed agent',
        model: json['model'] as String? ?? 'unknown',
        status: json['status'] as String? ?? 'offline',
        task: json['currentTask'] as String?,
        goal: json['currentGoal'] as String?,
        activity: json['currentActivity'] as String?,
        controlMode: json['controlMode'] as String? ?? 'monitor_only',
        workspaceLabel: json['workspaceLabel'] as String?,
        managedSessionId: json['managedSessionId'] as String?,
        tokensOut: (json['tokensOut'] as num?)?.toInt() ?? 0,
        tier: json['tier'] as String? ?? 'middle',
        subAgents: (json['subAgents'] as List?)?.length ?? 0,
      );

  bool get working => const {
        'thinking',
        'responding',
        'tool_use',
        'collaboration',
      }.contains(status);
}

class Stats {
  const Stats({
    required this.totalAgents,
    required this.activeAgents,
    required this.tokensOut,
  });
  final int totalAgents;
  final int activeAgents;
  final int tokensOut;

  factory Stats.fromJson(Map<String, dynamic> json) => Stats(
        totalAgents: (json['totalAgents'] as num?)?.toInt() ?? 0,
        activeAgents: (json['activeAgents'] as num?)?.toInt() ?? 0,
        tokensOut: (json['totalTokensOut'] as num?)?.toInt() ?? 0,
      );
}

class ActivityEvent {
  const ActivityEvent({required this.kind, required this.title, this.detail});
  final String kind;
  final String title;
  final String? detail;
  factory ActivityEvent.fromJson(Map<String, dynamic> json) => ActivityEvent(
        kind: json['kind'] as String? ?? 'status',
        title: json['title'] as String? ?? 'Activity',
        detail: json['detail'] as String?,
      );
}

class OfficeApi {
  OfficeApi(String baseUrl, String token)
      : baseUrl = baseUrl.replaceFirst(RegExp(r'/+$'), ''),
        token = token
            .trim()
            .replaceFirst(RegExp(r'^Bearer\s+', caseSensitive: false), '');
  final String baseUrl;
  final String token;
  final HttpClient _client = HttpClient()
    ..connectionTimeout = const Duration(seconds: 8);

  Future<dynamic> _request(String method, String path, [Object? payload]) =>
      _performRequest(method, path, payload).timeout(
        const Duration(seconds: 20),
        onTimeout: () => throw const OfficeApiException(
            'Server tidak merespons. Draft tetap disimpan; periksa timeline sebelum mengirim ulang.'),
      );

  Future<dynamic> _performRequest(
      String method, String path, Object? payload) async {
    final request = await _client.openUrl(method, Uri.parse('$baseUrl$path'));
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    if (payload != null) {
      request.headers.contentType = ContentType.json;
      final bytes = utf8.encode(jsonEncode(payload));
      // The local server accepts Content-Length, not chunked request bodies.
      request.contentLength = bytes.length;
      request.add(bytes);
    }
    final response = await request.close();
    final body = await response.transform(utf8.decoder).join();
    if (response.statusCode == 401)
      throw const OfficeApiException(
          'Token tidak cocok. Salin token dari desktop yang sedang aktif.');
    if (response.statusCode == 530)
      throw const OfficeApiException(
          'Tunnel tidak tersambung ke desktop. Buka ulang tunnel dan gunakan URL terbaru.');
    if (response.statusCode < 200 || response.statusCode >= 300) {
      String reason = 'Server ${response.statusCode}';
      try {
        final data = jsonDecode(body) as Map<String, dynamic>;
        reason =
            data['message'] as String? ?? data['error'] as String? ?? reason;
      } catch (_) {}
      throw OfficeApiException(reason);
    }
    return jsonDecode(body);
  }

  Future<dynamic> _get(String path) => _request('GET', path);

  Future<(List<Agent>, Stats)> load() async {
    final results = await Future.wait<dynamic>([
      _get('/api/agents'),
      _get('/api/stats'),
    ]);
    final agents = (results[0] as List)
        .map((item) => Agent.fromJson(item as Map<String, dynamic>))
        .toList();
    return (agents, Stats.fromJson(results[1] as Map<String, dynamic>));
  }

  Future<List<ActivityEvent>> activities(String id) async => (await _get(
              '/api/v1/agents/${Uri.encodeComponent(id)}/activities?limit=50')
          as List)
      .map((item) => ActivityEvent.fromJson(item as Map<String, dynamic>))
      .toList();

  Future<Map<String, dynamic>> capabilities() async =>
      (await _get('/api/v1/capabilities')) as Map<String, dynamic>;

  Future<Agent> agent(String id) async =>
      Agent.fromJson(await _get('/api/v1/agents/${Uri.encodeComponent(id)}')
          as Map<String, dynamic>);

  Future<Map<String, dynamic>> control(String id) async =>
      await _get('/api/v1/agents/${Uri.encodeComponent(id)}/control')
          as Map<String, dynamic>;

  Future<bool> sendMessage(String id, String message, String mode) async {
    final result = await _request(
        'POST', '/api/v1/agents/${Uri.encodeComponent(id)}/messages', {
      'message': message,
      'mode': mode,
    });
    return result['queued'] == true;
  }

  Future<void> createAgent(
      String provider, String workspaceId, String message) async {
    await _request('POST', '/api/v1/agents', {
      'provider': provider,
      'workspaceId': workspaceId,
      if (message.trim().isNotEmpty) 'initialMessage': message.trim(),
    });
  }

  void dispose() => _client.close(force: true);
}

class OfficeApiException implements Exception {
  const OfficeApiException(this.message);
  final String message;
  @override
  String toString() => message;
}

class RemoteHomePage extends StatefulWidget {
  const RemoteHomePage({super.key});
  @override
  State<RemoteHomePage> createState() => _RemoteHomePageState();
}

class _RemoteHomePageState extends State<RemoteHomePage>
    with WidgetsBindingObserver {
  final _url = TextEditingController();
  final _token = TextEditingController();
  OfficeApi? _api;
  Timer? _poller;
  List<Agent> _agents = const [];
  Stats? _stats;
  String? _error;
  bool _busy = false;
  Map<String, dynamic> _capabilities = const {};
  WebViewController? _sceneController;
  bool _sceneReady = false;
  String? _sceneError;
  bool _sceneFullscreen = false;
  bool _refreshing = false;
  bool _foreground = true;
  bool _sheetOpen = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    unawaited(_sceneController
        ?.runJavaScript('window.pauseOfficeScene(${!_foreground});'));
    if (_foreground) unawaited(_refresh());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    if (_sceneFullscreen) {
      unawaited(SystemChrome.setEnabledSystemUIMode(
        SystemUiMode.manual,
        overlays: SystemUiOverlay.values,
      ));
    }
    _poller?.cancel();
    _api?.dispose();
    _url.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final baseUrl = _url.text.trim();
    final token = _token.text.trim();
    if (baseUrl.isEmpty || token.isEmpty) {
      setState(() => _error = 'URL dan token wajib diisi.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final api = OfficeApi(baseUrl, token);
    try {
      final data = await api.load();
      final capabilities = await api.capabilities();
      if (!mounted) {
        api.dispose();
        return;
      }
      _api?.dispose();
      _api = api;
      setState(() {
        _agents = data.$1;
        _stats = data.$2;
        _capabilities = capabilities;
        _busy = false;
      });
      _ensureSceneController();
      _syncScene();
      _poller?.cancel();
      _poller = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
    } catch (error) {
      api.dispose();
      setState(() {
        _busy = false;
        _error = 'Tidak bisa terhubung: $error';
      });
    }
  }

  Future<void> _refresh() async {
    final api = _api;
    if (api == null || _refreshing || !_foreground) return;
    _refreshing = true;
    try {
      final data = await api.load();
      if (!mounted || _api != api) return;
      setState(() {
        _agents = data.$1;
        _stats = data.$2;
        _error = null;
      });
      _syncScene();
    } catch (_) {
      if (mounted) setState(() => _error = 'Koneksi terputus. Mencoba lagi…');
    } finally {
      _refreshing = false;
    }
  }

  void _disconnect() {
    if (_sceneFullscreen) _setSceneFullscreen(false);
    _poller?.cancel();
    _api?.dispose();
    setState(() {
      _api = null;
      _stats = null;
      _agents = const [];
      _capabilities = const {};
      _error = null;
    });
  }

  Future<void> _newAgent() async {
    final api = _api;
    if (api == null) return;
    final message = TextEditingController();
    final providers = ((_capabilities['providers'] as List?) ?? const [])
        .whereType<String>()
        .toList();
    final workspaces = ((_capabilities['workspaces'] as List?) ?? const [])
        .whereType<Map>()
        .map((item) => (item['id'] as String?) ?? '')
        .where((id) => id.isNotEmpty)
        .toList();
    if (providers.isEmpty || workspaces.isEmpty) {
      message.dispose();
      setState(
          () => _error = 'Provider atau workspace belum tersedia di desktop.');
      return;
    }
    var provider = providers.first;
    var workspaceId = workspaces.first;
    final created = await showDialog<bool>(
      context: context,
      builder: (_) => StatefulBuilder(builder: (context, setDialogState) {
        return AlertDialog(
          title: const Text('New agent'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            DropdownButtonFormField<String>(
              initialValue: provider,
              decoration: const InputDecoration(labelText: 'Provider'),
              items: providers
                  .map((item) =>
                      DropdownMenuItem(value: item, child: Text(item)))
                  .toList(),
              onChanged: (value) =>
                  setDialogState(() => provider = value ?? provider),
            ),
            DropdownButtonFormField<String>(
              initialValue: workspaceId,
              decoration: const InputDecoration(labelText: 'Workspace'),
              items: workspaces
                  .map((item) =>
                      DropdownMenuItem(value: item, child: Text(item)))
                  .toList(),
              onChanged: (value) =>
                  setDialogState(() => workspaceId = value ?? workspaceId),
            ),
            TextField(
                controller: message,
                maxLines: 3,
                decoration: const InputDecoration(
                    labelText: 'Initial instruction (optional)')),
          ]),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Batal')),
            FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Open terminal')),
          ],
        );
      }),
    );
    if (created != true) {
      message.dispose();
      return;
    }
    try {
      await api.createAgent(provider, workspaceId, message.text);
      if (mounted) setState(() => _error = 'Terminal $provider sedang dibuka…');
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      message.dispose();
    }
  }

  @override
  Widget build(BuildContext context) => _api == null
      ? _buildConnect()
      : _sceneFullscreen
          ? PopScope(
              canPop: false,
              onPopInvokedWithResult: (didPop, _) {
                if (!didPop) _setSceneFullscreen(false);
              },
              child: Scaffold(body: SizedBox.expand(child: _buildScene())),
            )
          : _buildDashboard();

  void _setSceneFullscreen(bool value) {
    setState(() => _sceneFullscreen = value);
    unawaited(SystemChrome.setEnabledSystemUIMode(
      value ? SystemUiMode.immersiveSticky : SystemUiMode.manual,
      overlays: value ? [] : SystemUiOverlay.values,
    ));
  }

  Widget _buildScene() => Stack(
        children: [
          Positioned.fill(
            child: _sceneController == null
                ? const ColoredBox(
                    color: Color(0xff10101c),
                    child: Center(child: CircularProgressIndicator()),
                  )
                : _sceneError != null
                    ? ColoredBox(
                        color: const Color(0xff10101c),
                        child: Center(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  const Icon(Icons.view_in_ar, size: 32),
                                  const SizedBox(height: 12),
                                  Text('3D scene gagal dimuat: $_sceneError',
                                      textAlign: TextAlign.center),
                                  TextButton.icon(
                                      onPressed: _retryScene,
                                      icon: const Icon(Icons.refresh),
                                      label: const Text('Muat ulang 3D')),
                                ]),
                          ),
                        ),
                      )
                    : WebViewWidget(controller: _sceneController!),
          ),
          if (!_sceneReady && _sceneError == null)
            const Positioned.fill(
                child: IgnorePointer(
                    child: ColoredBox(
              color: Color(0xdd10101c),
              child: Center(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                CircularProgressIndicator(),
                SizedBox(height: 14),
                Text('Menyiapkan kantor 3D…'),
              ])),
            ))),
          Positioned(
              left: 8,
              top: 8,
              child: SafeArea(
                  child: IconButton.filledTonal(
                tooltip: 'Kembali ke seluruh kantor',
                icon: const Icon(Icons.center_focus_strong),
                onPressed: _sceneReady
                    ? () => _sceneController
                        ?.runJavaScript('window.resetOfficeCamera();')
                    : null,
              ))),
          Positioned(
            right: 8,
            top: 8,
            child: SafeArea(
              child: IconButton.filledTonal(
                tooltip:
                    _sceneFullscreen ? 'Keluar fullscreen' : 'Fullscreen 3D',
                onPressed: () => _setSceneFullscreen(!_sceneFullscreen),
                icon: Icon(_sceneFullscreen
                    ? Icons.fullscreen_exit
                    : Icons.fullscreen),
              ),
            ),
          ),
        ],
      );

  Widget _buildConnect() => Scaffold(
        body: SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(24, 48, 24, 24),
            children: [
              const Text(
                'OFFICEAI',
                style: TextStyle(
                  letterSpacing: 3,
                  color: Color(0xffe9b949),
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 18),
              Align(
                  alignment: Alignment.centerLeft,
                  child: Image.asset('assets/officeai-logo.png',
                      width: 72, height: 72)),
              const SizedBox(height: 18),
              const Text(
                'Lihat workspace\ndari mana saja.',
                style: TextStyle(
                  fontSize: 32,
                  height: 1.05,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 14),
              Text(
                'Buka Remote di desktop OfficeAI, lalu masukkan URL Cloudflare dan token yang ditampilkan.',
                style: TextStyle(color: Colors.grey.shade400, height: 1.5),
              ),
              const SizedBox(height: 32),
              TextField(
                controller: _url,
                keyboardType: TextInputType.url,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(
                  labelText: 'Cloudflare URL',
                  hintText: 'https://....trycloudflare.com',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 14),
              TextField(
                controller: _token,
                obscureText: true,
                onSubmitted: (_) => _connect(),
                decoration: const InputDecoration(
                  labelText: 'Bearer token',
                  border: OutlineInputBorder(),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 14),
                Text(_error!, style: const TextStyle(color: Color(0xffff9b9b))),
              ],
              const SizedBox(height: 22),
              FilledButton(
                onPressed: _busy ? null : _connect,
                child: Text(_busy ? 'Menghubungkan…' : 'Hubungkan ke office'),
              ),
            ],
          ),
        ),
      );

  Widget _buildDashboard() {
    _ensureSceneController();
    final stats = _stats!;
    return Scaffold(
      appBar: AppBar(
        title: const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('OfficeAI', style: TextStyle(fontWeight: FontWeight.w700)),
            Text(
              'REMOTE WORKSPACE',
              style: TextStyle(
                fontSize: 10,
                letterSpacing: 1.5,
                color: Color(0xffaaa8bb),
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
              onPressed: _newAgent,
              tooltip: 'New agent',
              icon: const Icon(Icons.add)),
          IconButton(
            onPressed: _refresh,
            tooltip: 'Refresh sekarang',
            icon: const Icon(Icons.refresh),
          ),
          TextButton(onPressed: _disconnect, child: const Text('Putus')),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        children: [
          SizedBox(
            height:
                (MediaQuery.sizeOf(context).height * .43).clamp(280.0, 480.0),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: _buildScene(),
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              _Stat(
                label: 'WORKING',
                value: '${stats.activeAgents}',
                color: const Color(0xff60d394),
              ),
              const SizedBox(width: 8),
              _Stat(
                label: 'AGENTS',
                value: '${stats.totalAgents}',
                color: const Color(0xffe9b949),
              ),
              const SizedBox(width: 8),
              _Stat(
                label: 'TOKENS OUT',
                value: _formatNumber(stats.tokensOut),
                color: const Color(0xff8eb8ff),
              ),
            ],
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(
                _error!,
                style: const TextStyle(color: Color(0xffffc46b)),
              ),
            ),
          const SizedBox(height: 24),
          const Text(
            'AGENTS',
            style: TextStyle(
              letterSpacing: 1.4,
              fontSize: 12,
              color: Color(0xffaaa8bb),
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 8),
          if (_agents.isEmpty)
            const _EmptyAgents()
          else
            ..._agents.map(
              (agent) => Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _AgentTile(agent: agent, onTap: () => _showAgent(agent)),
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _showAgent(Agent agent) async {
    final api = _api;
    if (api == null || _sheetOpen) return;
    _sheetOpen = true;
    unawaited(_sceneController
        ?.runJavaScript('window.focusOfficeAgent(${jsonEncode(agent.id)});'));
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      builder: (_) => _AgentDetailSheet(agent: agent, api: api),
    );
    _sheetOpen = false;
  }

  void _retryScene() {
    setState(() {
      _sceneReady = false;
      _sceneError = null;
    });
    unawaited(
        _sceneController?.loadFlutterAsset('assets/office_scene/index.html'));
  }

  void _ensureSceneController() {
    if (_sceneController != null) return;
    final controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel('sceneReady', onMessageReceived: (_) {
        if (!mounted) return;
        setState(() {
          _sceneReady = true;
          _sceneError = null;
        });
        _syncScene();
        unawaited(_sceneController
            ?.runJavaScript('window.pauseOfficeScene(${!_foreground});'));
      })
      ..addJavaScriptChannel('sceneError', onMessageReceived: (message) {
        if (mounted) setState(() => _sceneError = message.message);
      })
      ..addJavaScriptChannel('agentSelected', onMessageReceived: (message) {
        final matches = _agents.where((agent) => agent.id == message.message);
        if (matches.isNotEmpty) _showAgent(matches.first);
      })
      ..setNavigationDelegate(NavigationDelegate(onWebResourceError: (error) {
        if (mounted && error.isForMainFrame == true) {
          setState(() => _sceneError = error.description);
        }
      }));
    _sceneController = controller;
    unawaited(controller
        .loadFlutterAsset('assets/office_scene/index.html')
        .catchError((error) {
      if (mounted) setState(() => _sceneError = error.toString());
    }));
  }

  void _syncScene() {
    final controller = _sceneController;
    if (controller == null || !_sceneReady) return;
    final payload = jsonEncode(_agents
        .map((agent) => {
              'id': agent.id,
              'name': agent.name,
              'model': agent.model,
              'status': agent.status,
              'currentTask': agent.task,
              'currentGoal': agent.goal,
              'currentActivity': agent.activity,
              'controlMode': agent.controlMode,
              'workspaceLabel': agent.workspaceLabel,
              'managedSessionId': agent.managedSessionId,
              'tokensIn': 0,
              'tokensOut': agent.tokensOut,
              'tier': agent.tier,
              'subAgents': const [],
              'lastActivity': DateTime.now().toUtc().toIso8601String(),
              'startedAt': DateTime.now().toUtc().toIso8601String(),
              'source': 'remote_api',
            })
        .toList());
    controller.runJavaScript('window.syncAgents($payload);');
  }
}

class _AgentDetailSheet extends StatefulWidget {
  const _AgentDetailSheet({required this.agent, required this.api});
  final Agent agent;
  final OfficeApi api;
  @override
  State<_AgentDetailSheet> createState() => _AgentDetailSheetState();
}

class _AgentDetailSheetState extends State<_AgentDetailSheet> {
  final _message = TextEditingController();
  late Agent _agent;
  List<ActivityEvent> _activities = const [];
  Map<String, dynamic> _control = const {};
  Timer? _poller;
  bool _refreshing = false;
  bool _loading = true;
  bool _sending = false;
  String? _error;
  String? _receipt;

  @override
  void initState() {
    super.initState();
    _agent = widget.agent;
    _load();
    _poller = Timer.periodic(const Duration(seconds: 2), (_) {
      if (WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed)
        _load();
    });
  }

  @override
  void dispose() {
    _poller?.cancel();
    _message.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    if (_refreshing) return;
    _refreshing = true;
    try {
      final results = await Future.wait<dynamic>([
        widget.api.agent(widget.agent.id),
        widget.api.control(widget.agent.id),
        widget.api.activities(widget.agent.id),
      ]);
      if (mounted)
        setState(() {
          _agent = results[0] as Agent;
          _control = results[1] as Map<String, dynamic>;
          _activities = (results[2] as List<ActivityEvent>).reversed.toList();
          _loading = false;
          _error = null;
        });
    } catch (error) {
      if (mounted)
        setState(() {
          _error = error.toString();
          _loading = false;
        });
    } finally {
      _refreshing = false;
    }
  }

  Future<void> _send(String mode) async {
    if (_message.text.trim().isEmpty || _sending || _control['canSend'] != true)
      return;
    if (utf8.encode(_message.text.trim()).length > 4000) {
      setState(
          () => _error = 'Prompt maksimal 4000 byte. Pendekkan instruksinya.');
      return;
    }
    if (mode == 'interrupt' && !await _confirmInterrupt()) return;
    if (!mounted) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final queued = await widget.api
          .sendMessage(widget.agent.id, _message.text.trim(), mode);
      if (!mounted) return;
      _message.clear();
      setState(() => _receipt = queued
          ? 'Antrean tersimpan. Dikirim setelah task selesai.'
          : 'Dikirim ke terminal. Tunggu aktivitas agent di timeline.');
      await _load();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<bool> _confirmInterrupt() async =>
      await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
          title: const Text('Interrupt agent?'),
          content: const Text(
              'Task sekarang akan dihentikan sebelum prompt baru dikirim.'),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(context, false),
                child: const Text('Batal')),
            FilledButton(
                onPressed: () => Navigator.pop(context, true),
                child: const Text('Interrupt')),
          ],
        ),
      ) ??
      false;

  @override
  Widget build(BuildContext context) {
    final canSend = _control['canSend'] == true;
    final queued = _control['queued'] == true;
    final size = MediaQuery.sizeOf(context);
    final keyboard = MediaQuery.viewInsetsOf(context).bottom;
    return Padding(
      padding: EdgeInsets.only(bottom: keyboard),
      child: SizedBox(
        height: (size.height * .82 - keyboard).clamp(260.0, size.height * .82),
        child:
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 12, 12),
              child: Row(children: [
                Expanded(
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                      Text(_agent.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              fontSize: 21, fontWeight: FontWeight.w700)),
                      Text(
                          '${_agent.workspaceLabel ?? _agent.model} · ${_statusLabel(_agent.status)}',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                              color: Color(0xffaaa8bb), fontSize: 12)),
                    ])),
                IconButton(
                    onPressed: _load,
                    tooltip: 'Periksa status',
                    icon: const Icon(Icons.refresh)),
                IconButton(
                    onPressed: () => Navigator.pop(context),
                    tooltip: 'Tutup',
                    icon: const Icon(Icons.close)),
              ])),
          if (_loading) const LinearProgressIndicator(),
          Expanded(
              child: ListView(
                  padding: const EdgeInsets.symmetric(horizontal: 20),
                  children: [
                Text(_agent.goal ?? _agent.task ?? 'Siap menerima instruksi.',
                    style: const TextStyle(height: 1.45)),
                const SizedBox(height: 8),
                Text(_agent.activity ?? _statusLabel(_agent.status),
                    style: const TextStyle(color: Color(0xff60d394))),
                const SizedBox(height: 16),
                const Text('LIVE TIMELINE',
                    style: TextStyle(
                        fontSize: 11,
                        letterSpacing: 1.2,
                        color: Color(0xffaaa8bb))),
                if (_activities.isEmpty)
                  const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Text('Belum ada aktivitas.')),
                ..._activities.take(25).map((event) => ExpansionTile(
                      tilePadding: EdgeInsets.zero,
                      leading: Icon(
                          event.kind == 'error'
                              ? Icons.error_outline
                              : event.kind == 'prompt'
                                  ? Icons.send_outlined
                                  : Icons.code,
                          size: 20),
                      title: Text(event.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 13)),
                      subtitle: Text(event.kind.replaceAll('_', ' '),
                          style: const TextStyle(fontSize: 11)),
                      children: [
                        if (event.detail != null)
                          Padding(
                              padding: const EdgeInsets.only(bottom: 12),
                              child: SelectableText(event.detail!))
                      ],
                    )),
              ])),
          SafeArea(
              top: false,
              child: Container(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                decoration: const BoxDecoration(
                    border: Border(top: BorderSide(color: Color(0xff373649)))),
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_error != null)
                        Text(_error!,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: Color(0xffff9b9b), fontSize: 12)),
                      if (_receipt != null)
                        Padding(
                            padding: const EdgeInsets.only(bottom: 8),
                            child: Text(_receipt!,
                                style: const TextStyle(
                                    color: Color(0xff60d394), fontSize: 12))),
                      if (!canSend) ...[
                        Text(
                            _loading
                                ? 'Memeriksa transport terminal…'
                                : '${_control['reason'] ?? 'Terminal belum terhubung.'}',
                            style: const TextStyle(fontSize: 12)),
                        TextButton.icon(
                            onPressed: _load,
                            icon: const Icon(Icons.link),
                            label: const Text('Coba hubungkan terminal')),
                      ] else ...[
                        Text(
                            queued
                                ? '1 prompt menunggu · ${_control['transport']}'
                                : 'Terhubung via ${_control['transport']} · terminal terverifikasi',
                            style: const TextStyle(
                                color: Color(0xffaaa8bb), fontSize: 11)),
                        const SizedBox(height: 8),
                        TextField(
                            controller: _message,
                            minLines: 1,
                            maxLines: 3,
                            maxLength: 4000,
                            enabled: !_sending,
                            onChanged: (_) => setState(() {}),
                            decoration: const InputDecoration(
                                hintText: 'Instruksi untuk agent ini…',
                                border: OutlineInputBorder(),
                                counterText: '')),
                        const SizedBox(height: 8),
                        Row(children: [
                          Expanded(
                              child: FilledButton.icon(
                            onPressed: _sending ||
                                    _message.text.trim().isEmpty ||
                                    (_agent.working && queued)
                                ? null
                                : () => _send(_agent.working ? 'queue' : 'now'),
                            icon: Icon(
                                _agent.working
                                    ? Icons.playlist_add
                                    : Icons.send,
                                size: 18),
                            label: Text(_sending
                                ? 'Mengirim…'
                                : _agent.working
                                    ? 'Antrekan'
                                    : 'Kirim'),
                          )),
                          if (_agent.working) ...[
                            const SizedBox(width: 8),
                            OutlinedButton(
                                onPressed:
                                    _sending || _message.text.trim().isEmpty
                                        ? null
                                        : () => _send('interrupt'),
                                child: const Text('Interrupt'))
                          ],
                        ]),
                      ],
                    ]),
              )),
        ]),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.label, required this.value, required this.color});
  final String label;
  final String value;
  final Color color;
  @override
  Widget build(BuildContext context) => Expanded(
        child: Container(
          padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
          decoration: BoxDecoration(
            color: const Color(0xff171724),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 9,
                  letterSpacing: 1,
                  color: color,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 5),
              Text(
                value,
                style:
                    const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
              ),
            ],
          ),
        ),
      );
}

class _AgentTile extends StatelessWidget {
  const _AgentTile({required this.agent, required this.onTap});
  final Agent agent;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Card(
        color: const Color(0xff171724),
        margin: EdgeInsets.zero,
        child: ListTile(
          minVerticalPadding: 10,
          onTap: onTap,
          leading: CircleAvatar(
            backgroundColor: _tierColor(agent.tier),
            child: Icon(
              agent.working ? Icons.bolt : Icons.person,
              size: 18,
              color: const Color(0xff10101c),
            ),
          ),
          title: Text(agent.name, maxLines: 1, overflow: TextOverflow.ellipsis),
          subtitle: Text(
            agent.task ?? _statusLabel(agent.status),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          trailing: Text(
            _statusLabel(agent.status),
            style: TextStyle(
              color: agent.working
                  ? const Color(0xff60d394)
                  : const Color(0xffaaa8bb),
              fontSize: 12,
            ),
          ),
        ),
      );
}

class _EmptyAgents extends StatelessWidget {
  const _EmptyAgents();
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          border: Border.all(color: const Color(0xff373649)),
          borderRadius: BorderRadius.circular(10),
        ),
        child: const Text(
          'Belum ada agent yang terdeteksi. Jalankan agent di desktop untuk melihat aktivitasnya di sini.',
          style: TextStyle(color: Color(0xffaaa8bb), height: 1.45),
        ),
      );
}

Color _tierColor(String tier) => switch (tier) {
      'expert' => const Color(0xffe9b949),
      'senior' => const Color(0xff8eb8ff),
      'junior' => const Color(0xffb9b7c5),
      _ => const Color(0xff70b47a),
    };

String _statusLabel(String status) => switch (status) {
      'tool_use' => 'Using tool',
      'task_complete' => 'Complete',
      'walking_to_desk' => 'Walking',
      'collaboration' => 'Collaborating',
      _ => status.isEmpty
          ? 'Unknown'
          : '${status[0].toUpperCase()}${status.substring(1)}',
    };

String _formatNumber(int value) {
  if (value >= 1000000) return '${(value / 1000000).toStringAsFixed(1)}M';
  if (value >= 1000) return '${(value / 1000).toStringAsFixed(1)}K';
  return '$value';
}
