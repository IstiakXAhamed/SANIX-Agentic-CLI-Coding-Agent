/**
 * @file tools/tool-use.ts
 * @description 5 prompts that require the model to invoke tools (read a
 * file, run a command, etc.). These are agent-style benchmarks — the
 * suite is expected to wire a `chatFn` that runs the AgentLoop with
 * tools registered.
 *
 * Scoring is `contains` against the expected file/command output
 * fragment.
 *
 * @packageDocumentation
 */

import type { Benchmark } from '../../types.js';

/**
 * 5 tool-use prompts. Each requires the model to call a tool to retrieve
 * information that isn't in its training data; the expected answer is a
 * substring of the tool's output.
 */
export const toolUse: Benchmark = {
  id: 'tool-use',
  name: 'Tool Use',
  description:
    '5 prompts that require tool calls (read_file, list_files, run_command). Use with a chatFn that wires the AgentLoop.',
  category: 'tools',
  scoring: { type: 'contains' },
  timeout: 180_000,
  prompts: [
    {
      id: 't1',
      input:
        'Read the file `package.json` in the current directory and tell me the value of the "name" field.',
      context: {
        files: {
          'package.json':
            '{"name":"sanix-test-fixture","version":"1.2.3","private":true}',
        },
      },
      expected: 'sanix-test-fixture',
      maxIterations: 3,
    },
    {
      id: 't2',
      input:
        'Run the command `echo hello-tool-bench` and tell me exactly what it prints.',
      expected: 'hello-tool-bench',
      maxIterations: 3,
    },
    {
      id: 't3',
      input:
        'List the files in the current directory. The fixture directory contains exactly one file named marker.txt — confirm by reporting its name.',
      context: {
        files: {
          'marker.txt': 'sanix tool-use benchmark fixture',
        },
      },
      expected: 'marker.txt',
      maxIterations: 3,
    },
    {
      id: 't4',
      input:
        'Read the file `config.json` and report the value of the "port" field as a number.',
      context: {
        files: {
          'config.json': '{"port":4242,"host":"127.0.0.1"}',
        },
      },
      expected: '4242',
      maxIterations: 3,
    },
    {
      id: 't5',
      input:
        'Run `node --version` (or `node -v`) and report the major version number (just the digit, e.g. 20).',
      expected: 'v',
      maxIterations: 3,
    },
  ],
};
