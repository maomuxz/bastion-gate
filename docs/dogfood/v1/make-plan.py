import json, sys
root = sys.argv[1]
OLD = 'dist-test/tests/bastion.test.js dist-test/tests/v04-*.test.js dist-test/tests/v041-*.test.js'

def tc(name):
    return f'npm run build && npm run build:test && node --test dist-test/tests/v1-{name}.test.js {OLD}'

COMMON = ('Project: bastion-gate (TypeScript, Node 18+, zero runtime dependencies, ESM with .js import suffixes). '
          'Interfaces are frozen: keep every exported signature and the doc comments; implement the TODO / stub bodies exactly as the '
          'doc comments specify. Read your file(s), the shared types in src/commands/stages.ts and src/map.ts, the helpers you may reuse '
          '(runRole and resolveAgentCommand in src/roles.ts, runLock, runSwarm, readRunState/writeRunState, execGit in src/git.ts), and the locked test before coding.')

N = [
    ('p1-map-core', 'Map core (validate, diff, render, plan)', 'map-core', 'src/map.ts', [], 'Implement the TODO functions in src/map.ts.'),
    ('p10-split', 'Recursive split', 'split', 'src/split.ts', [], 'Implement mapDepth and splitNode in src/split.ts.'),
    ('p2-map-cmd', 'bastion map', 'map-cmd', 'src/commands/map.ts', ['p1-map-core', 'p10-split'],
     'Implement runMap in src/commands/map.ts. Write clear planner prompts (requirement, top-level files, the BastionMap JSON schema, '
     'rules: one owner per file, small nodes, exact interfaces, testable acceptance sentences, a test file + command per node).'),
    ('p3-review', 'bastion review', 'review', 'src/commands/review.ts', [], 'Implement renderBrief, isMapApproved and runReview in src/commands/review.ts.'),
    ('p12-scaffold', 'bastion scaffold', 'scaffold', 'src/commands/scaffold.ts', [], 'Implement runScaffold in src/commands/scaffold.ts.'),
    ('p4-tests-cmd', 'bastion tests', 'tests-cmd', 'src/commands/tests.ts', [], 'Implement runTests in src/commands/tests.ts.'),
    ('p5-single', 'Single-session mode', 'single', 'src/single.ts', [], 'Implement resolveRunMode and mergeNodesForSingle in src/single.ts (run.ts already uses them).'),
    ('p6-slots', 'Compile slot pool', 'slots', 'src/slots.ts', [], 'Implement createSlotPool in src/slots.ts with a real FIFO limit (run.ts already wraps gate runs with it).'),
    ('p7-qa', 'bastion qa', 'qa', 'src/commands/qa.ts', [], 'Implement parseQaReport and runQa in src/commands/qa.ts (run.ts already feeds .bastion/feedback/<node>.md to reopened nodes).'),
    ('p9-regress', 'Regression finder', 'regress', 'src/commands/regress.ts', [], 'Implement findRegression in src/commands/regress.ts (runRegress is done).'),
    ('p8-flow', 'bastion flow', 'flow', 'src/commands/flow.ts', ['p2-map-cmd', 'p3-review', 'p12-scaffold', 'p4-tests-cmd', 'p7-qa'],
     'Implement runFlow in src/commands/flow.ts by chaining the existing commands.'),
    ('p11-readme', 'README feature matrix', 'readme', 'README.md and README.zh-CN.md', [],
     'Update README.md and README.zh-CN.md: add a "Original design vs implemented" / "原设计 vs 已实现" table between the lines '
     '<!-- feature-matrix:start --> and <!-- feature-matrix:end -->, one row per feature with the command in backticks and ✅: '
     '`map`, `review`, `scaffold`, `tests`, `run`, `gate`, `lock`, `mutate`, `audit`, `qa`, `flow`, `summary`, `decisions`, `answer`, '
     '`budget`, `checks`, `roles`, each with one short plain sentence. Also add a short "Fortress flow" section explaining '
     '`bastion flow "<requirement>"` and the four human touch points (requirement, review --approve, answers, final merge), '
     'and document roles (planner, blind, tester, worker, qa), runMode/singleMaxNodes and compileSlots in the config section. '
     'Plain, calm tone; no marketing claims and no performance numbers. Do not touch other files.'),
]

nodes = []
for nid, title, name, files, deps, task in N:
    edit = f'Edit only {files}.'
    nodes.append({
        'id': nid, 'title': title,
        'prompt': f'{COMMON}\n\n{task} {edit} Acceptance: tests/v1-{name}.test.ts (locked).\n\nYour node test command: {tc(name)}',
        'testCommand': tc(name), 'tier': 1, **({'dependsOn': deps} if deps else {}),
    })
open(root + '/.bastion/plan.json', 'w', encoding='utf8', newline='\n').write(json.dumps({'version': 1, 'nodes': nodes}, indent=2, ensure_ascii=False) + '\n')

cfg_path = root + '/.bastion/config.json'
cfg = json.load(open(cfg_path, encoding='utf8'))
cfg['concurrency'] = 3
open(cfg_path, 'w', encoding='utf8', newline='\n').write(json.dumps(cfg, indent=2) + '\n')
print(len(nodes))
