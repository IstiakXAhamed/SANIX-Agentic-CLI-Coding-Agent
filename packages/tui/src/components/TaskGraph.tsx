/**
 * @file TaskGraph — visual plan tree with `├─` / `└─` connectors and
 * status icons (`[✓]`, `[▶]`, `[ ]`, `[✗]`).
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';
import type { TaskNodeView, TaskStatus } from '../types.js';

/** Props for {@link TaskGraph}. */
export interface TaskGraphProps {
  /** Root-level plan tasks. */
  readonly tasks: readonly TaskNodeView[];
  /** Theme override. */
  readonly theme?: SanixTheme;
}

/** Status icon per {@link TaskStatus}. */
export const TASK_STATUS_ICON: Record<TaskStatus, string> = {
  done: '[✓]',
  active: '[▶]',
  pending: '[ ]',
  failed: '[✗]',
};

/** Status display label per {@link TaskStatus}. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  done: 'done',
  active: 'active',
  pending: 'pending',
  failed: 'failed',
};

/** Theme color key per {@link TaskStatus}. */
const TASK_STATUS_COLOR_KEY: Record<TaskStatus, keyof SanixTheme> = {
  done: 'success',
  active: 'primary',
  pending: 'muted',
  failed: 'error',
};

interface TaskRowProps {
  readonly node: TaskNodeView;
  readonly isLast: boolean;
  readonly prefix: string;
  readonly theme: SanixTheme;
}

const TaskRow: React.FC<TaskRowProps> = ({ node, isLast, prefix, theme }) => {
  const connector = isLast ? '└─' : '├─';
  const icon = TASK_STATUS_ICON[node.status];
  const color = theme[TASK_STATUS_COLOR_KEY[node.status]];
  const label = TASK_STATUS_LABEL[node.status];
  const children = node.children ?? [];
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.dim}>
          {prefix}
          {connector}{' '}
        </Text>
        <Text color={color}>{icon}</Text>
        <Text> {node.title}</Text>
        <Text color={theme.muted}>  {label}</Text>
        {node.detail ? <Text color={theme.secondary}>  {node.detail}</Text> : null}
      </Box>
      {children.map((child, i) => (
        <TaskRow
          key={child.id}
          node={child}
          isLast={i === children.length - 1}
          prefix={prefix + (isLast ? '  ' : '│ ')}
          theme={theme}
        />
      ))}
    </Box>
  );
};

/**
 * Render the active plan as a tree. The first row is a `PLAN | STATUS`
 * header so the columns line up with the spec layout.
 *
 * @example
 * ```tsx
 * <TaskGraph tasks={[
 *   { id: '1', title: 'Analyze auth', status: 'done', detail: '3 files read' },
 *   { id: '2', title: 'Write JWT service', status: 'active' },
 * ]} />
 * ```
 */
export const TaskGraph: React.FC<TaskGraphProps> = ({ tasks, theme = sanixTheme }) => {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.primary} bold>
          PLAN
        </Text>
        <Text>                          </Text>
        <Text color={theme.primary} bold>
          STATUS
        </Text>
      </Box>
      {tasks.length === 0 ? (
        <Text color={theme.dim}>No tasks planned yet.</Text>
      ) : (
        tasks.map((node, i) => (
          <TaskRow
            key={node.id}
            node={node}
            isLast={i === tasks.length - 1}
            prefix=""
            theme={theme}
          />
        ))
      )}
    </Box>
  );
};

export default TaskGraph;
