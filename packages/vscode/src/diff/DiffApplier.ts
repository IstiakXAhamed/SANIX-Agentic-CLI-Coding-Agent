/**
 * @fileoverview Parses ```diff fenced blocks out of an assistant message and
 * applies them to the workspace via `vscode.WorkspaceEdit` (with native undo).
 * @module sanix.vscode/diff/DiffApplier
 */
import * as vscode from "vscode";

/** A single parsed hunk — the lines after the `+++ ` header determine the target file. */
interface ParsedDiff {
  filePath: string;
  hunks: { added: string[]; removed: string[] }[];
  raw: string;
}

const FENCE_RE = /```diff\n([\s\S]*?)```/g;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Parse all ```diff fenced blocks out of `text` into structured hunks.
 */
export function parseDiffs(text: string): ParsedDiff[] {
  const diffs: ParsedDiff[] = [];
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const body = m[1];
    const parsed = parseOneDiff(body);
    if (parsed) diffs.push(parsed);
  }
  return diffs;
}

function parseOneDiff(body: string): ParsedDiff | null {
  const lines = body.split("\n");
  let filePath = "";
  let currentHunk: { added: string[]; removed: string[] } | null = null;
  const hunks: { added: string[]; removed: string[] }[] = [];
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      // Normalize `+++ b/path/to/file.ts` → `path/to/file.ts`
      filePath = p.replace(/^[ab]\//, "").replace(/^\/dev\/null$/, "");
      continue;
    }
    if (line.startsWith("--- ")) continue; // source path — unused for apply
    if (HUNK_HEADER_RE.test(line)) {
      currentHunk = { added: [], removed: [] };
      hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.added.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.removed.push(line.slice(1));
    } else if (line.startsWith(" ") || line === "") {
      // context line — ignored
    }
  }
  if (!filePath) return null;
  return { filePath, hunks, raw: body };
}

/**
 * Apply parsed diffs to the workspace using a single `WorkspaceEdit`.
 * Returns the number of files modified.
 */
export async function applyDiffs(
  diffs: ParsedDiff[],
  options: { openAfterApply?: boolean } = {},
): Promise<number> {
  if (diffs.length === 0) return 0;
  const ws = new vscode.WorkspaceEdit();
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  let modified = 0;
  for (const diff of diffs) {
    const uri = vscode.Uri.file(`${wsRoot}/${diff.filePath}`);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      // New file — create empty then apply.
      ws.createFile(uri);
      doc = await vscode.workspace.openTextDocument(uri);
    }
    for (const hunk of diff.hunks) {
      const removedText = hunk.removed.join("\n");
      const addedText = hunk.added.join("\n");
      // Find the first occurrence of the removed block; if not found, append at EOF.
      const fullText = doc.getText();
      const idx = removedText ? fullText.indexOf(removedText) : -1;
      if (idx >= 0) {
        const start = doc.positionAt(idx);
        const end = doc.positionAt(idx + removedText.length);
        ws.replace(uri, new vscode.Range(start, end), addedText);
      } else {
        const lastLine = doc.lineAt(doc.lineCount - 1);
        ws.insert(uri, lastLine.rangeIncludingLineBreak.end, `\n${addedText}`);
      }
    }
    modified++;
  }
  await vscode.workspace.applyEdit(ws);
  if (options.openAfterApply) {
    for (const diff of diffs) {
      const uri = vscode.Uri.file(`${wsRoot}/${diff.filePath}`);
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }
  return modified;
}
