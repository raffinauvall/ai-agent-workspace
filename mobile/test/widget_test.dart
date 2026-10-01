import 'package:flutter_test/flutter_test.dart';

import 'package:office_ai_remote/main.dart';

void main() {
  testWidgets('connect screen renders', (WidgetTester tester) async {
    await tester.pumpWidget(const OfficeRemoteApp());

    expect(find.text('OFFICEAI'), findsOneWidget);
    expect(find.text('Hubungkan ke office'), findsOneWidget);
  });
}
