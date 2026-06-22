/**
 * @file DiffViewer — unified-diff renderer with green/red/cyan/dim
 * coloring and an interactive collapse toggle (`d`).
 *
 * Supported line kinds (per the unified diff spec):
 *   - `+...`     → added line   (success / green)
 *   - `-...`     → removed line (error / red)
 *   - `@@ ... @@`→ hunk header  (primary / cyan)
 *   - `+++`/`---`→ file markers (muted)
 *   - everything else → context (dim)
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { SanixTheme } from '../themes/theme.types.js';
import { sanixTheme } from '../themes/sanix.theme.js';

/** Props for {@link DiffViewer}. */
export interface DiffViewerProps {
  /** Unified-diff string. */
  readonly diff: string;
  /** Max lines rendered when collapsed. Defaults to 50. */
  readonly maxLines?: number;
  /** Initial expand state. User may toggle with `d`. Defaults to false. */
  readonly expanded?: boolean;
  /** Theme override. */
  readonly theme?: SanixTheme;
}

/** Internal parsed-line kind. */
type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context';

interface ParsedLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/**
 * Parse a unified-diff string into typed lines.
 *
 * @internal
 */
export function parseDiff(diff: string): ParsedLine[] {
  return diff.split('\n').map((line) => {
    if (line.startsWith('@@')) return { kind: 'hunk', text: line };
    if (line.startsWith('+++') || line.startsWith('---')) {
      return { kind: 'meta', text: line };
    }
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
    if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1) };
    return { kind: 'context', text: line };
  });
}

function colorFor(kind: DiffLineKind, theme: SanixTheme): string {
  switch (kind) {
    case 'add':
      return theme.success;
    case 'del':
      return theme.error;
    case 'hunk':
      return theme.primary;
    case 'meta':
      return theme.muted;
    default:
      return theme.dim;
  }
}

function prefixFor(kind: DiffLineKind): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'del':
      return '-';
    default:
      return ' ';
  }
}

/**
 * Render a unified diff. Collapses to the first `maxLines` lines by
 * default; press `d` to toggle expansion.
 *
 * @example
 * ```tsx
 * <DiffViewer diff={unifiedDiffString} maxLines={30} />
 * ```
 */
export const DiffViewer: React.FC<DiffViewerProps> = ({
  diff,
  maxLines = 50,
  expanded: expandedInitial = false,
  theme = sanixTheme,
}) => {
  const [expanded, setExpanded] = useState<boolean>(expandedInitial);

  useInput((input) => {
    if (input === 'd' || input === 'D') {
      setExpanded((v) => !v);
    }
  });

  const allLines = parseDiff(diff);
  const visible = expanded ? allLines : allLines.slice(0, maxLines);
  const hidden = Math.max(0, allLines.length - visible.length);

  return (
    <Box flexDirection="column">
      {visible.map((line, i) => (
        <Box key={i}>
          <Text color={colorFor(line.kind, theme)}>
            {prefixFor(line.kind)}
            {line.text}
          </Text>
        </Box>
      ))}
      {hidden > 0 ? (
        <Text color={theme.muted}>… +{hidden} more (press d to {expanded ? 'collapse' : 'expand'})</Text>
      ) : null}
    </Box>
  );
};

export default DiffViewer;
