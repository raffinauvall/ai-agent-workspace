import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:office_ai_remote/main.dart';

void main() {
  test('remote receipts and actionable authentication errors', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final api =
        OfficeApi('http://127.0.0.1:${server.port}/', 'Bearer local-test');
    final handler = server.listen((request) async {
      expect(request.headers.value(HttpHeaders.authorizationHeader),
          'Bearer local-test');
      request.response.headers.contentType = ContentType.json;
      if (request.method == 'POST') {
        expect(request.contentLength, greaterThan(0));
        final data = jsonDecode(
            await request.cast<List<int>>().transform(utf8.decoder).join());
        expect(data['message'], 'Keep this literal: \$(no shell)');
        request.response.write(jsonEncode({
          'queued': data['mode'] == 'queue',
          'sent': data['mode'] == 'now'
        }));
      } else {
        request.response.statusCode = HttpStatus.unauthorized;
        request.response.write('{"error":"unauthorized"}');
      }
      await request.response.close();
    });
    try {
      expect(
          await api.sendMessage(
              'agent', 'Keep this literal: \$(no shell)', 'queue'),
          isTrue);
      expect(
          await api.sendMessage(
              'agent', 'Keep this literal: \$(no shell)', 'now'),
          isFalse);
      await expectLater(
          api.control('agent'),
          throwsA(isA<OfficeApiException>().having(
              (e) => e.message, 'message', contains('Token tidak cocok'))));
    } finally {
      api.dispose();
      await handler.cancel();
      await server.close(force: true);
    }
  });
}
