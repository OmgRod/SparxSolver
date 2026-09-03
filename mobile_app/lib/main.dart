import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SparxSolverApp());
}

class SparxSolverApp extends StatelessWidget {
  const SparxSolverApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SparxSolver Mobile',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark().copyWith(
        scaffoldBackgroundColor: const Color(0xFF0F0F1A),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF6C63FF),
          secondary: Color(0xFFA78BFA),
          surface: Color(0xFF1A1A2E),
        ),
      ),
      home: const SparxBrowserScreen(),
    );
  }
}

class SparxBrowserScreen extends StatefulWidget {
  const SparxBrowserScreen({super.key});

  @override
  State<SparxBrowserScreen> createState() => _SparxBrowserScreenState();
}

class _SparxBrowserScreenState extends State<SparxBrowserScreen> {
  InAppWebViewController? _webViewController;
  final TextEditingController _apiKeyController = TextEditingController();
  final List<String> _logs = [];
  final List<Map<String, String>> _bookworks = [];
  bool _isAutomationRunning = false;

  @override
  void initState() {
    super.initState();
    _loadSavedApiKeys();
  }

  Future<void> _loadSavedApiKeys() async {
    final prefs = await SharedPreferences.getInstance();
    final keys = prefs.getString('api_keys') ?? '';
    setState(() {
      _apiKeyController.text = keys;
    });
  }

  Future<void> _saveApiKeys(String keys) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('api_keys', keys);
  }

  void _addLog(String text, String level) {
    final time = DateTime.now().toString().split(' ')[1].substring(0, 8);
    setState(() {
      _logs.insert(0, '[$time] $text');
    });
  }

  void _toggleAutomation() async {
    final rawKeys = _apiKeyController.text.trim();
    if (rawKeys.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please enter at least one Gemini API Key!')),
      );
      return;
    }

    final keysList = rawKeys.split('\n').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
    await _saveApiKeys(rawKeys);

    if (_isAutomationRunning) {
      await _webViewController?.evaluateJavascript(source: "SparxEngine.stopAutomation();");
      setState(() => _isAutomationRunning = false);
    } else {
      final jsonKeys = jsonEncode(keysList);
      await _webViewController?.evaluateJavascript(source: "SparxEngine.startAutomation($jsonKeys);");
      setState(() => _isAutomationRunning = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(0xFF1A1A2E),
        title: const Text('SparxSolver', style: TextStyle(fontWeight: FontWeight.bold)),
        actions: [
          IconButton(
            icon: Icon(_isAutomationRunning ? Icons.stop_circle : Icons.play_circle, 
                 color: _isAutomationRunning ? Colors.redAccent : const Color(0xFF4ADE80)),
            onPressed: _toggleAutomation,
          ),
          Builder(
            builder: (context) => IconButton(
              icon: Stack(
                children: [
                  const Icon(Icons.terminal),
                  if (_logs.isNotEmpty)
                    Positioned(
                      right: 0,
                      top: 0,
                      child: Container(
                        padding: const EdgeInsets.all(2),
                        decoration: const BoxDecoration(color: Color(0xFF6C63FF), shape: BoxShape.circle),
                        constraints: const BoxConstraints(minWidth: 10, minHeight: 10),
                      ),
                    )
                ],
              ),
              onPressed: () => Scaffold.of(context).openDrawer(),
              tooltip: 'Live Logs',
            ),
          ),
          Builder(
            builder: (context) => IconButton(
              icon: const Icon(Icons.settings),
              onPressed: () => Scaffold.of(context).openEndDrawer(),
              tooltip: 'Settings & Keys',
            ),
          ),
        ],
      ),
      drawer: Drawer(
        backgroundColor: const Color(0xFF0F0F1A),
        child: SafeArea(
          child: Column(
            children: [
              Container(
                padding: const EdgeInsets.all(16),
                color: const Color(0xFF1A1A2E),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.terminal, color: Color(0xFFA78BFA)),
                        const SizedBox(width: 8),
                        const Text('Live Logs', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: Colors.white)),
                        const SizedBox(width: 6),
                        Text('(${_logs.length})', style: const TextStyle(fontSize: 12, color: Colors.grey)),
                      ],
                    ),
                    Row(
                      children: [
                        IconButton(
                          icon: const Icon(Icons.delete_outline, color: Colors.grey),
                          onPressed: () => setState(() => _logs.clear()),
                          tooltip: 'Clear Logs',
                        ),
                        IconButton(
                          icon: const Icon(Icons.close, color: Colors.white70),
                          onPressed: () => Navigator.of(context).pop(),
                        ),
                      ],
                    )
                  ],
                ),
              ),
              Expanded(
                child: Container(
                  padding: const EdgeInsets.all(8.0),
                  child: ListView.builder(
                    itemCount: _logs.length,
                    itemBuilder: (context, index) {
                      final logText = _logs[index];
                      Color logColor = Colors.white70;
                      if (logText.contains('[JS ERR]') || logText.contains('Error')) {
                        logColor = Colors.redAccent;
                      } else if (logText.contains('[JS WARN]')) {
                        logColor = Colors.amberAccent;
                      } else if (logText.contains('🤖 AI Tool:')) {
                        logColor = const Color(0xFF60A5FA);
                      } else if (logText.contains('✓ Question Finished')) {
                        logColor = const Color(0xFF4ADE80);
                      }

                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2.0),
                        child: SelectableText(
                          logText,
                          style: TextStyle(fontFamily: 'monospace', fontSize: 11, color: logColor),
                        ),
                      );
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
      endDrawer: Drawer(
        backgroundColor: const Color(0xFF1A1A2E),
        child: Padding(
          padding: const EdgeInsets.all(16.0),
          child: ListView(
            children: [
              const Text('Gemini API Keys', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Colors.white)),
              const SizedBox(height: 6),
              const Text('Enter one or more API keys (one per line):', style: TextStyle(fontSize: 12, color: Colors.grey)),
              const SizedBox(height: 12),
              TextField(
                controller: _apiKeyController,
                maxLines: 4,
                style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
                decoration: const InputDecoration(
                  border: OutlineInputBorder(),
                  hintText: 'AIzaSy...',
                  fillColor: Color(0xFF0F0F1A),
                  filled: true,
                ),
              ),
              const SizedBox(height: 20),
              ElevatedButton.icon(
                onPressed: _toggleAutomation,
                style: ElevatedButton.styleFrom(
                  backgroundColor: _isAutomationRunning ? Colors.redAccent : const Color(0xFF6C63FF),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
                icon: Icon(_isAutomationRunning ? Icons.stop : Icons.play_arrow),
                label: Text(_isAutomationRunning ? 'Stop Automation' : 'Start Automation'),
              ),
              const SizedBox(height: 30),
              const Text('Bookwork Log', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
              const Divider(),
              if (_bookworks.isEmpty) const Text('No saved bookworks yet.', style: TextStyle(fontSize: 12, color: Colors.grey)),
              ..._bookworks.map((b) => ListTile(
                title: Text('Code: ${b['code']}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                subtitle: Text('Answer: ${b['answer']}', style: const TextStyle(color: Color(0xFFA78BFA), fontSize: 12)),
              )),
            ],
          ),
        ),
      ),
      body: InAppWebView(
        initialUrlRequest: URLRequest(url: WebUri("https://sparxmaths.uk")),
        onWebViewCreated: (controller) {
          _webViewController = controller;

          // Set up JavaScript bridge handler
          controller.addJavaScriptHandler(
            handlerName: 'SparxBridge',
            callback: (args) {
              final data = args[0];
              final String type = data['type'] ?? '';
              final payload = data['payload'] ?? {};

              if (type == 'log') {
                _addLog(payload['text'] ?? '', payload['level'] ?? 'info');
              } else if (type == 'bookwork_add') {
                setState(() {
                  _bookworks.add({'code': payload['code'], 'answer': payload['answer']});
                });
              }
            },
          );
        },
        onLoadStop: (controller, url) async {
          // Inject embedded Sparx Engine JS script into page context
          final jsCode = await rootBundle.loadString('assets/sparx_engine_bridge.js');
          await controller.evaluateJavascript(source: jsCode);
          _addLog('Loaded Sparx Engine into page.', 'info');
        },
      ),
    );
  }
}
