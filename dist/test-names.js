/**
 * Extract human-readable test names from common test file formats
 * so a reviewer can scan what is locked in plain language.
 */
export function extractTestNames(content) {
    const names = [];
    const seen = new Set();
    const add = (raw) => {
        const cleaned = raw.trim().replace(/\s+/g, ' ');
        if (cleaned && !seen.has(cleaned)) {
            seen.add(cleaned);
            names.push(cleaned);
        }
    };
    // JS/TS/Dart: it('...'), test('...'), describe('...'), testWidgets('...')
    const jsPattern = /^\s*(?:it|test|testWidgets|describe|group)(?:\.(?:only|skip|todo))?\(\s*(['"`])((?:\\.|(?!\1).)+)\1/gm;
    for (const m of content.matchAll(jsPattern)) {
        add(m[2]);
    }
    // Python: def test_something(...)
    const pyPattern = /^\s*(?:async\s+)?def\s+(test_[a-zA-Z0-9_]+)\s*\(/gm;
    for (const m of content.matchAll(pyPattern)) {
        add(m[1].replace(/^test_/, '').replace(/_/g, ' '));
    }
    // Go: func TestSomething(t *testing.T)
    const goPattern = /^\s*func\s+(Test[a-zA-Z0-9_]+)\s*\(/gm;
    for (const m of content.matchAll(goPattern)) {
        add(m[1]);
    }
    // Rust: #[test] fn something()
    const rustPattern = /#\[(?:tokio::)?test\]\s*(?:async\s+)?fn\s+([a-zA-Z0-9_]+)\s*\(/gm;
    for (const m of content.matchAll(rustPattern)) {
        add(m[1].replace(/_/g, ' '));
    }
    return names;
}
