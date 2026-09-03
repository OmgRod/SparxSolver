import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_inappwebview_platform_interface/flutter_inappwebview_platform_interface.dart';
import 'package:flutter/widgets.dart';
import 'package:mobile_app/main.dart';

class MockInAppWebViewWidget extends PlatformInAppWebViewWidget {
  MockInAppWebViewWidget(PlatformInAppWebViewWidgetCreationParams params) : super.implementation(params);

  @override
  Widget build(BuildContext context) {
    return const SizedBox();
  }

  @override
  void dispose() {}

  @override
  T controllerFromPlatform<T>(PlatformInAppWebViewController controller) {
    return controller as T;
  }
}

class MockInAppWebViewPlatform extends InAppWebViewPlatform {
  @override
  PlatformInAppWebViewWidget createPlatformInAppWebViewWidget(PlatformInAppWebViewWidgetCreationParams params) {
    return MockInAppWebViewWidget(params);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    InAppWebViewPlatform.instance = MockInAppWebViewPlatform();
  });

  testWidgets('App load test', (WidgetTester tester) async {
    await tester.pumpWidget(const SparxSolverApp());
    expect(find.text('SparxSolver Mobile'), findsOneWidget);
  });
}
