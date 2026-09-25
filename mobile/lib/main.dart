import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';

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
    required this.name,
    required this.model,
    required this.status,
    required this.task,
    required this.tokensOut,
    required this.tier,
    required this.subAgents,
  });
  final String name;
  final String model;
  final String status;
  final String? task;
  final int tokensOut;
  final String tier;
  final int subAgents;

  factory Agent.fromJson(Map<String, dynamic> json) => Agent(
    name: json['name'] as String? ?? 'Unnamed agent',
    model: json['model'] as String? ?? 'unknown',
    status: json['status'] as String? ?? 'offline',
    task: json['currentTask'] as String?,
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

class OfficeApi {
  OfficeApi(String baseUrl, String token)
    : baseUrl = baseUrl.replaceFirst(RegExp(r'/+$'), ''),
      token = token.trim();
  final String baseUrl;
  final String token;
  final HttpClient _client = HttpClient();

  Future<dynamic> _get(String path) async {
    final request = await _client.getUrl(Uri.parse('$baseUrl$path'));
    request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    final response = await request.close();
    final body = await response.transform(utf8.decoder).join();
    if (response.statusCode < 200 || response.statusCode >= 300)
      throw Exception('Server ${response.statusCode}: $body');
    return jsonDecode(body);
  }

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

  void dispose() => _client.close(force: true);
}

class RemoteHomePage extends StatefulWidget {
  const RemoteHomePage({super.key});
  @override
  State<RemoteHomePage> createState() => _RemoteHomePageState();
}

class _RemoteHomePageState extends State<RemoteHomePage> {
  final _url = TextEditingController();
  final _token = TextEditingController();
  OfficeApi? _api;
  Timer? _poller;
  List<Agent> _agents = const [];
  Stats? _stats;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
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
      _api?.dispose();
      _api = api;
      setState(() {
        _agents = data.$1;
        _stats = data.$2;
        _busy = false;
      });
      _poller?.cancel();
      _poller = Timer.periodic(const Duration(seconds: 2), (_) => _refresh());
    } catch (_) {
      api.dispose();
      setState(() {
        _busy = false;
        _error = 'Tidak bisa terhubung. Pastikan tunnel dan token benar.';
      });
    }
  }

  Future<void> _refresh() async {
    final api = _api;
    if (api == null) return;
    try {
      final data = await api.load();
      if (!mounted) return;
      setState(() {
        _agents = data.$1;
        _stats = data.$2;
        _error = null;
      });
    } catch (_) {
      if (mounted) setState(() => _error = 'Koneksi terputus. Mencoba lagi…');
    }
  }

  void _disconnect() {
    _poller?.cancel();
    _api?.dispose();
    setState(() {
      _api = null;
      _stats = null;
      _agents = const [];
      _error = null;
    });
  }

  @override
  Widget build(BuildContext context) =>
      _api == null ? _buildConnect() : _buildDashboard();

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
            height: 260,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: CustomPaint(painter: OfficePainter(_agents)),
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

  void _showAgent(Agent agent) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(22, 4, 22, 24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                agent.name,
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                agent.model,
                style: const TextStyle(color: Color(0xffaaa8bb)),
              ),
              const SizedBox(height: 18),
              Text(
                agent.task ?? 'Tidak ada task aktif.',
                style: const TextStyle(height: 1.45),
              ),
              const SizedBox(height: 16),
              Text(
                'Status: ${_statusLabel(agent.status)}  ·  ${agent.subAgents} sub-agent',
                style: const TextStyle(color: Color(0xffaaa8bb)),
              ),
            ],
          ),
        ),
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
            style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
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

class OfficePainter extends CustomPainter {
  const OfficePainter(this.agents);
  final List<Agent> agents;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawRect(
      Offset.zero & size,
      Paint()..color = const Color(0xff181829),
    );
    final center = Offset(size.width / 2, size.height / 2 + 14);
    final floor = Path()
      ..moveTo(center.dx, 18)
      ..lineTo(size.width - 18, center.dy)
      ..lineTo(center.dx, size.height - 18)
      ..lineTo(18, center.dy)
      ..close();
    canvas.drawPath(floor, Paint()..color = const Color(0xff9a6432));
    canvas.drawPath(
      floor,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1.5
        ..color = const Color(0xffd18c46),
    );
    final gridPaint = Paint()
      ..color = const Color(0x35f0c27b)
      ..strokeWidth = 1;
    for (var step = -5; step <= 5; step++) {
      canvas.drawLine(
        Offset(center.dx + step * size.width / 10, 18),
        Offset(center.dx + step * size.width / 20, size.height - 18),
        gridPaint,
      );
      canvas.drawLine(
        Offset(18 + step * size.width / 20, center.dy),
        Offset(size.width - 18 + step * size.width / 20, center.dy),
        gridPaint,
      );
    }
    final positions = [
      Offset(center.dx - 70, center.dy - 24),
      Offset(center.dx + 46, center.dy - 8),
      Offset(center.dx - 12, center.dy + 42),
      Offset(center.dx + 105, center.dy + 24),
    ];
    for (var index = 0; index < 6; index++)
      _drawDesk(
        canvas,
        positions[index % positions.length] +
            Offset(
              (index ~/ positions.length) * 28.0,
              (index ~/ positions.length) * 10.0,
            ),
      );
    for (var index = 0; index < agents.length; index++)
      _drawAgent(
        canvas,
        positions[index % positions.length] + const Offset(0, -22),
        agents[index],
      );
  }

  void _drawDesk(Canvas canvas, Offset at) {
    final top = Path()
      ..moveTo(at.dx, at.dy)
      ..lineTo(at.dx + 32, at.dy - 14)
      ..lineTo(at.dx + 62, at.dy)
      ..lineTo(at.dx + 30, at.dy + 15)
      ..close();
    canvas.drawPath(top, Paint()..color = const Color(0xffd9a35b));
    canvas.drawPath(
      Path()
        ..moveTo(at.dx + 30, at.dy + 15)
        ..lineTo(at.dx + 62, at.dy)
        ..lineTo(at.dx + 62, at.dy + 8)
        ..lineTo(at.dx + 30, at.dy + 24)
        ..close(),
      Paint()..color = const Color(0xff9d642e),
    );
    canvas.drawRect(
      Rect.fromLTWH(at.dx + 24, at.dy - 16, 14, 9),
      Paint()..color = const Color(0xff5e9dcc),
    );
  }

  void _drawAgent(Canvas canvas, Offset at, Agent agent) {
    final color = agent.working
        ? const Color(0xff60d394)
        : _tierColor(agent.tier);
    canvas.drawOval(
      Rect.fromCenter(center: at + const Offset(0, 18), width: 30, height: 8),
      Paint()..color = const Color(0x55000000),
    );
    canvas.drawCircle(at, 7, Paint()..color = const Color(0xffffd1aa));
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: at + const Offset(0, 12),
          width: 16,
          height: 16,
        ),
        const Radius.circular(4),
      ),
      Paint()..color = color,
    );
    if (agent.working) {
      canvas.drawCircle(
        at + const Offset(-8, -12),
        3,
        Paint()..color = const Color(0xffe9b949),
      );
      canvas.drawCircle(
        at + const Offset(0, -16),
        3,
        Paint()..color = const Color(0xffe9b949),
      );
      canvas.drawCircle(
        at + const Offset(8, -12),
        3,
        Paint()..color = const Color(0xffe9b949),
      );
    }
  }

  @override
  bool shouldRepaint(covariant OfficePainter oldDelegate) =>
      oldDelegate.agents != agents;
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
  _ =>
    status.isEmpty
        ? 'Unknown'
        : '${status[0].toUpperCase()}${status.substring(1)}',
};

String _formatNumber(int value) {
  if (value >= 1000000) return '${(value / 1000000).toStringAsFixed(1)}M';
  if (value >= 1000) return '${(value / 1000).toStringAsFixed(1)}K';
  return '$value';
}
