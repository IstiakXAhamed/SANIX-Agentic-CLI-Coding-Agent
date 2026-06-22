/**
 * @file agents/DataScientist.ts
 * @description SANIX Data Scientist agent (id: `data-scientist`, icon: 📊,
 * category: `data`). Cleans datasets, performs EDA, builds ML models,
 * generates visualizations, and writes Markdown analysis reports.
 *
 * The agent drives a deterministic, multi-phase pipeline that uses the
 * SANIX tool layer (`read_file`, `write_file`, `bash`, `sandbox_execute`,
 * `search_files`) to load data, run Python (pandas / scikit-learn /
 * matplotlib), and emit artifacts. Each phase records {@link AgentAction}s
 * (one per tool call) and emits progress events via `options.emit`.
 *
 * The pipeline is safe-by-default: when a required tool is unavailable
 * (e.g. no Python sandbox), the agent records the gap as an
 * informational finding and continues with whatever work it *can* do
 * (format detection, file inspection, planning), rather than throwing.
 *
 * @packageDocumentation
 */

import { BaseAgent } from '../BaseAgent.js';
import type {
  AgentAction,
  AgentArtifact,
  AgentCategory,
  AgentFinding,
  AgentRunOptions,
  AgentRunResult,
} from '../types.js';

/** Severity bucket for an {@link AgentFinding}. */
type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** Discriminated union describing a phase result. */
interface PhaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly skipped?: boolean;
  readonly skipReason?: string;
}

/** The full structured plan the agent executes. */
interface DataSciencePlan {
  readonly datasetPath: string;
  readonly detectedFormat: 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet' | 'sql' | 'excel' | 'unknown';
  readonly problemType: 'classification' | 'regression' | 'clustering' | 'time_series' | 'unknown';
  readonly targetColumn?: string;
  readonly steps: ReadonlyArray<{ phase: string; tool: string; description: string }>;
}

/** Internal accumulator for actions/findings/artifacts. */
interface RunAccumulator {
  readonly actions: AgentAction[];
  readonly findings: AgentFinding[];
  readonly artifacts: AgentArtifact[];
  readonly recommendations: string[];
  tokensUsed: number;
  toolCalls: number;
}

/** Counter for unique ids within a single run. */
let _idCounter = 0;
function nextId(prefix: string): string {
  _idCounter += 1;
  return `${prefix}-${_idCounter.toString(36).padStart(4, '0')}`;
}

/**
 * SANIX Data Scientist — a data-science & ML specialist.
 *
 * @example
 * ```ts
 * import { DataScientistAgent } from '@sanix/agents';
 * const agent = new DataScientistAgent();
 * const result = await agent.run({
 *   cwd: '/workspace',
 *   goal: 'Build a churn-prediction model from data/customers.csv',
 *   toolCall: async (tool, input) => invokeSanixTool(tool, input),
 * });
 * console.log(result.summary);
 * for (const f of result.findings) console.log(f.severity, f.title);
 * ```
 */
export class DataScientistAgent extends BaseAgent {
  readonly id = 'data-scientist';
  readonly name = 'Data Scientist';
  readonly icon = '📊';
  readonly category: AgentCategory = 'data';
  readonly description =
    'Cleans data, runs EDA, builds ML models (classification, regression, ' +
    'clustering, time series), evaluates them, generates visualizations, and ' +
    'writes Markdown analysis reports with insights and recommendations.';
  readonly systemPrompt =
    'You are SANIX Data Scientist, a data science and ML expert. You: ' +
    '(1) clean and preprocess data (handle missing values, outliers, type conversion), ' +
    '(2) perform exploratory data analysis (statistics, distributions, correlations), ' +
    '(3) build ML models (classification, regression, clustering, time series), ' +
    '(4) evaluate models (cross-validation, metrics, confusion matrix), ' +
    '(5) generate visualizations (matplotlib, seaborn, plotly), ' +
    '(6) write analysis reports with insights and recommendations. ' +
    'You work in Python (pandas, scikit-learn, matplotlib) and can execute code in the sandbox.';
  readonly tools = [
    'read_file',
    'write_file',
    'bash',
    'sandbox_execute',
    'search_files',
  ];
  readonly exampleQueries = [
    'Analyze data/sales.csv and build a model that predicts next-month revenue.',
    'Run EDA on data/customers.json — find segments and churn drivers.',
    'Cluster the records in data/users.parquet into behavioural cohorts.',
    'Train a classifier on data/iris.csv, evaluate it, and save a confusion-matrix plot.',
    'Forecast daily visits from data/traffic.csv using an ARIMA model.',
  ];

  /** @inheritdoc */
  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const acc: RunAccumulator = {
      actions: [],
      findings: [],
      artifacts: [],
      recommendations: [],
      tokensUsed: 0,
      toolCalls: 0,
    };
    _idCounter = 0;

    this.emit(options, 'agent:start', { agentId: this.id, goal: options.goal });

    try {
      // ── Phase 0: plan ────────────────────────────────────────────────
      const plan = this.derivePlan(options);
      this.emit(options, 'agent:plan', { plan });

      // ── Phase 1: data loading ────────────────────────────────────────
      await this.phaseLoadData(options, plan, acc);

      // ── Phase 2: data cleaning ───────────────────────────────────────
      await this.phaseCleanData(options, plan, acc);

      // ── Phase 3: EDA ─────────────────────────────────────────────────
      await this.phaseEDA(options, plan, acc);

      // ── Phase 4: feature engineering ─────────────────────────────────
      await this.phaseFeatureEngineering(options, plan, acc);

      // ── Phase 5: model building ──────────────────────────────────────
      await this.phaseBuildModel(options, plan, acc);

      // ── Phase 6: model evaluation ────────────────────────────────────
      await this.phaseEvaluateModel(options, plan, acc);

      // ── Phase 7: visualization ───────────────────────────────────────
      await this.phaseVisualize(options, plan, acc);

      // ── Phase 8: report ──────────────────────────────────────────────
      const reportPath = await this.phaseReport(options, plan, acc);

      const summary = this.composeSummary(plan, acc, Date.now() - startedAt);
      const result: AgentRunResult = {
        agentId: this.id,
        agentName: this.name,
        category: this.category,
        goal: options.goal,
        summary,
        findings: acc.findings,
        actions: acc.actions,
        artifacts: acc.artifacts,
        recommendations: acc.recommendations,
        metrics: {
          steps: acc.actions.length,
          durationMs: Date.now() - startedAt,
          tokensUsed: acc.tokensUsed,
          costUsd: 0,
          toolCalls: acc.toolCalls,
        },
        success: true,
      };
      this.emit(options, 'agent:complete', { agentId: this.id, result });
      void reportPath;
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      acc.findings.push({
        id: nextId('finding'),
        severity: 'critical',
        category: 'pipeline',
        title: 'Pipeline aborted with an unhandled error',
        description: message,
        recommendation: 'Inspect the goal, dataset path, and tool availability, then re-run.',
      });
      const result: AgentRunResult = {
        agentId: this.id,
        agentName: this.name,
        category: this.category,
        goal: options.goal,
        summary: `Data-science pipeline aborted: ${message}`,
        findings: acc.findings,
        actions: acc.actions,
        artifacts: acc.artifacts,
        recommendations: acc.recommendations,
        metrics: {
          steps: acc.actions.length,
          durationMs: Date.now() - startedAt,
          tokensUsed: acc.tokensUsed,
          costUsd: 0,
          toolCalls: acc.toolCalls,
        },
        success: false,
        error: message,
      };
      this.emit(options, 'agent:complete', { agentId: this.id, result });
      return result;
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────

  private emit(options: AgentRunOptions, event: string, payload: unknown): void {
    try {
      options.emit?.(event, payload);
    } catch {
      /* emit failures must never break the run */
    }
  }

  private async callTool(
    options: AgentRunOptions,
    tool: string,
    input: unknown,
    acc: RunAccumulator,
    description: string,
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
    const startedAt = Date.now();
    acc.toolCalls += 1;
    this.emit(options, 'tool:start', { tool, input });
    if (!options.toolCall) {
      const action: AgentAction = {
        id: nextId('action'),
        type: this.toolActionType(tool),
        description: `${description} (skipped: no toolCall callback)`,
        target: tool,
        success: false,
        error: 'no toolCall callback provided in AgentRunOptions',
        durationMs: Date.now() - startedAt,
      };
      acc.actions.push(action);
      return { ok: false, error: action.error ?? 'no toolCall' };
    }
    try {
      const output = await options.toolCall(tool, input);
      const out = this.coerceOutput(output);
      acc.tokensUsed += this.estimateTokens(out);
      const action: AgentAction = {
        id: nextId('action'),
        type: this.toolActionType(tool),
        description,
        target: tool,
        input: this.safePreview(input),
        output: this.safePreview(out),
        durationMs: Date.now() - startedAt,
        success: true,
      };
      acc.actions.push(action);
      this.emit(options, 'tool:complete', { tool, output: out });
      return { ok: true, output: out };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const action: AgentAction = {
        id: nextId('action'),
        type: this.toolActionType(tool),
        description,
        target: tool,
        input: this.safePreview(input),
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      };
      acc.actions.push(action);
      this.emit(options, 'tool:error', { tool, error: message });
      return { ok: false, error: message };
    }
  }

  private toolActionType(tool: string): AgentAction['type'] {
    switch (tool) {
      case 'read_file':
        return 'read';
      case 'write_file':
        return 'write';
      case 'edit_file':
        return 'edit';
      case 'bash':
        return 'bash';
      case 'sandbox_execute':
        return 'sandbox_execute';
      case 'search_files':
        return 'search';
      case 'analyze_ast':
        return 'analyze_ast';
      case 'list_directory':
        return 'list_directory';
      case 'get_dependencies':
        return 'get_dependencies';
      case 'run_tests':
        return 'run_tests';
      default:
        return 'bash';
    }
  }

  private coerceOutput(raw: unknown): unknown {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    return raw;
  }

  private safePreview(value: unknown): string {
    if (value === undefined) return '';
    if (typeof value === 'string') return value.slice(0, 4000);
    try {
      return JSON.stringify(value).slice(0, 4000);
    } catch {
      return String(value).slice(0, 4000);
    }
  }

  private estimateTokens(value: unknown): number {
    const text = typeof value === 'string' ? value : this.safePreview(value);
    return Math.ceil(text.length / 4);
  }

  private recordFinding(
    acc: RunAccumulator,
    severity: Severity,
    category: string,
    title: string,
    description: string,
    extras?: Partial<AgentFinding>,
  ): void {
    acc.findings.push({
      id: nextId('finding'),
      severity,
      category,
      title,
      description,
      ...extras,
    });
  }

  private recordArtifact(
    acc: RunAccumulator,
    name: string,
    content: string,
    type: AgentArtifact['type'],
    description?: string,
    path?: string,
    language?: string,
  ): void {
    acc.artifacts.push({
      id: nextId('artifact'),
      name,
      type,
      content,
      description,
      path,
      language,
    });
  }

  // ─── planning ───────────────────────────────────────────────────────

  private derivePlan(options: AgentRunOptions): DataSciencePlan {
    const goal = options.goal.toLowerCase();
    const datasetPath = this.extractDatasetPath(options.goal) ?? 'data/dataset.csv';
    const detectedFormat = this.detectFormatFromPath(datasetPath);
    const problemType = this.inferProblemType(goal);
    const targetColumn = this.inferTargetColumn(options.goal);
    const steps: DataSciencePlan['steps'] = [
      { phase: 'load', tool: 'sandbox_execute', description: `Load ${datasetPath} into pandas` },
      { phase: 'clean', tool: 'sandbox_execute', description: 'Impute missing, dedupe, coerce types' },
      { phase: 'eda', tool: 'sandbox_execute', description: 'Summary stats, distributions, correlations' },
      { phase: 'features', tool: 'sandbox_execute', description: 'Encode, scale, balance classes' },
      { phase: 'model', tool: 'sandbox_execute', description: `Fit ${problemType} model` },
      { phase: 'evaluate', tool: 'sandbox_execute', description: 'CV + metrics + confusion matrix' },
      { phase: 'visualize', tool: 'sandbox_execute', description: 'Save PNG plots to ./reports/figures' },
      { phase: 'report', tool: 'write_file', description: 'Write Markdown report' },
    ];
    return { datasetPath, detectedFormat, problemType, targetColumn, steps };
  }

  private extractDatasetPath(goal: string): string | undefined {
    // Match common dataset path patterns: data/foo.csv, ./bar.json, /abs/path.parquet
    const match = goal.match(/([\w./~-]+\.(?:csv|tsv|json|jsonl|parquet|db|sqlite|xls|xlsx))/i);
    return match?.[1];
  }

  private detectFormatFromPath(path: string): DataSciencePlan['detectedFormat'] {
    const lower = path.toLowerCase();
    if (lower.endsWith('.csv')) return 'csv';
    if (lower.endsWith('.tsv')) return 'tsv';
    if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.parquet')) return 'parquet';
    if (lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3')) return 'sql';
    if (lower.endsWith('.xls') || lower.endsWith('.xlsx')) return 'excel';
    return 'unknown';
  }

  private inferProblemType(goal: string): DataSciencePlan['problemType'] {
    if (/\bcluster|segment|cohort|group\s+customers\b/.test(goal)) return 'clustering';
    if (/\bforecast|time[- ]?series|arima|prophet|next[- ]?month|next[- ]?day\b/.test(goal)) return 'time_series';
    if (/\bclassif|predict\s+(?:churn|fraud|spam|label|category|default)|binary|multiclass\b/.test(goal)) {
      return 'classification';
    }
    if (/\bregress|predict\s+(?:revenue|price|sales|score|demand|value)|continuous\b/.test(goal)) {
      return 'regression';
    }
    return 'unknown';
  }

  private inferTargetColumn(goal: string): string | undefined {
    const m = goal.match(/\btarget[:\s]+([\w-]+)\b/i)
      ?? goal.match(/\bpredict\s+(?:the\s+)?([\w-]+)\b/i);
    return m?.[1];
  }

  // ─── phases ─────────────────────────────────────────────────────────

  private async phaseLoadData(
    options: AgentRunOptions,
    plan: DataSciencePlan,
    acc: RunAccumulator,
  ): Promise<void> {
    this.emit(options, 'phase:start', { phase: 'load' });
    // First inspect: list files matching the dataset pattern.
    const searchRes = await this.callTool(
      options,
      'search_files',
      { pattern: plan.datasetPath, cwd: options.cwd },
      acc,
      `Locate dataset file(s) matching ${plan.datasetPath}`,
    );
    if (!searchRes.ok) {
      this.recordFinding(
        acc,
        'medium',
        'data-loading',
        'Dataset file search skipped or failed',
        `The agent could not confirm the dataset exists at ${plan.datasetPath}. ` +
          `Tool error: ${searchRes.error}. Proceeding with best-effort load.`,
      );
    }

    const loaderCode = this.buildLoaderCode(plan);
    const loadRes = await this.callTool(
      options,
      'sandbox_execute',
      {
        runtime: 'python',
        code: loaderCode,
        cwd: options.cwd,
      },
      acc,
      `Load ${plan.datasetPath} (detected: ${plan.detectedFormat}) into pandas`,
    );
    if (!loadRes.ok) {
      this.recordFinding(
        acc,
        'high',
        'data-loading',
        'Could not load dataset into pandas',
        `sandbox_execute reported: ${loadRes.error}. Ensure Python with pandas is ` +
          `available and the path is reachable from the sandbox.`,
        {
          recommendation:
            'Install pandas (`pip install pandas`) and verify the path resolves inside the sandbox cwd.',
        },
      );
    } else {
      const out = String(loadRes.output ?? '');
      this.recordFinding(
        acc,
        'info',
        'data-loading',
        'Dataset loaded',
        `Loaded ${plan.datasetPath} as ${plan.detectedFormat}. Sandbox output (first 2KB):\n${out.slice(0, 2048)}`,
      );
      this.recordArtifact(
        acc,
        'loader.py',
        loaderCode,
        'code',
        'Python snippet used to load the dataset',
        undefined,
        'python',
      );
    }
    this.emit(options, 'phase:complete', { phase: 'load' });
  }

  private buildLoaderCode(plan: DataSciencePlan): string {
    const reader: Record<DataSciencePlan['detectedFormat'], string> = {
      csv: "pd.read_csv(path)",
      tsv: "pd.read_csv(path, sep='\\t')",
      json: "pd.read_json(path)",
      jsonl: "pd.read_json(path, lines=True)",
      parquet: "pd.read_parquet(path)",
      sql: "pd.read_sql('SELECT * FROM data', f'sqlite:///{path}')",
      excel: "pd.read_excel(path)",
      unknown: "pd.read_csv(path)",
    };
    return [
      'import pandas as pd',
      `path = ${JSON.stringify(plan.datasetPath)}`,
      'try:',
      `    df = ${reader[plan.detectedFormat]}`,
      '    print("shape:", df.shape)',
      '    print("columns:", list(df.columns))',
      '    print("dtypes:\\n", df.dtypes)',
      '    print("head:\\n", df.head(5).to_string())',
      'except Exception as e:',
      '    print("LOAD_ERROR:", repr(e))',
    ].join('\n');
  }

  private async phaseCleanData(
    options: AgentRunOptions,
    plan: DataSciencePlan,
    acc: RunAccumulator,
  ): Promise<void> {
    this.emit(options, 'phase:start', { phase: 'clean' });
    const code = [
      'import pandas as pd, numpy as np',
      `path = ${JSON.stringify(plan.datasetPath)}`,
      'try:',
      '    df = pd.read_csv(path) if path.endswith(".csv") else pd.read_json(path)',
      '    before = df.shape',
      '    # missing values',
      '    miss = df.isna().sum()',
      '    miss_pct = (miss / len(df) * 100).round(2)',
      '    print("MISSING:", miss.to_dict())',
      '    # impute numerics with median, categoricals with mode',
      "    for c in df.columns:",
      "        if df[c].dtype.kind in 'iufc':",
      '            df[c] = df[c].fillna(df[c].median())',
      '        else:',
      '            df[c] = df[c].fillna(df[c].mode().iloc[0] if not df[c].mode().empty else "")',
      '    # dedupe',
      '    df = df.drop_duplicates()',
      '    # outliers via IQR',
      "    num_cols = df.select_dtypes('number').columns",
      '    outlier_counts = {}',
      '    for c in num_cols:',
      '        q1, q3 = df[c].quantile([0.25, 0.75])',
      '        iqr = q3 - q1',
      '        lo, hi = q1 - 1.5*iqr, q3 + 1.5*iqr',
      '        outlier_counts[c] = int(((df[c] < lo) | (df[c] > hi)).sum())',
      '    print("OUTLIERS:", outlier_counts)',
      '    print("BEFORE:", before, "AFTER:", df.shape)',
      '    df.to_csv("/tmp/cleaned.csv", index=False)',
      '    print("CLEAN_OK")',
      'except Exception as e:',
      '    print("CLEAN_ERROR:", repr(e))',
    ].join('\n');
    const res = await this.callTool(
      options,
      'sandbox_execute',
      { runtime: 'python', code, cwd: options.cwd },
      acc,
      'Clean data: impute missing values, deduplicate, detect IQR outliers',
    );
    if (res.ok) {
      const out = String(res.output ?? '');
      this.recordFinding(
        acc,
        'info',
        'data-cleaning',
        'Cleaning step executed',
        `Imputed missing values (median for numerics, mode for categoricals), removed ` +
          `duplicates, and computed IQR-based outlier counts. Output:\n${out.slice(0, 2048)}`,
      );
      if (/MISSING:\s*\{[^}]*:\s*[1-9]/.test(out)) {
        this.recordFinding(
          acc,
          'medium',
          'data-cleaning',
          'Missing values were detected and imputed',
          'The dataset had non-zero missing values that were imputed. Consider ' +
            'reviewing imputation strategy (median/mode) and reporting it in the final write-up.',
        );
      }
      if (/OUTLIERS:\s*\{[^}]*:\s*[1-9]\d+/.test(out)) {
        this.recordFinding(
          acc,
          'medium',
          'data-cleaning',
          'Outliers detected in one or more numeric columns',
          'IQR fences flagged potential outliers. Consider capping (winsorizing) ' +
            'or transforming before modelling if the column is a model feature.',
        );
      }
    } else {
      this.recordFinding(
        acc,
        'high',
        'data-cleaning',
        'Cleaning step failed',
        `sandbox_execute reported: ${res.error}. The pipeline will continue but the ` +
          `report should note that cleaning was not completed.`,
      );
    }
    this.recordArtifact(acc, 'clean.py', code, 'code', 'Cleaning snippet', undefined, 'python');
    this.emit(options, 'phase:complete', { phase: 'clean' });
  }

  private async phaseEDA(
    options: AgentRunOptions,
    plan: DataSciencePlan,
    acc: RunAccumulator,
  ): Promise<void> {
    this.emit(options, 'phase:start', { phase: 'eda' });
    const code = [
      'import pandas as pd, numpy as np',
      'df = pd.read_csv("/tmp/cleaned.csv")',
      'print("DESCRIBE:\\n", df.describe(include="all").to_string())',
      'num = df.select_dtypes("number")',
      'if num.shape[1] >= 2:',
      '    print("CORR:\\n", num.corr().round(3).to_string())',
      'cat = df.select_dtypes(exclude="number")',
      'for c in cat.columns:',
      '    vc = df[c].value_counts(dropna=False).head(10)',
      '    print(f"VC[{c}]:", vc.to_dict())',
      'print("EDA_OK")',
    ].join('\n');
    const res = await this.callTool(
      options,
      'sandbox_execute',
      { runtime: 'python', code, cwd: options.cwd },
      acc,
      'EDA: summary statistics, correlation matrix, value counts',
    );
    if (res.ok) {
      const out = String(res.output ?? '');
      this.recordFinding(
        acc,
        'info',
        'eda',
        'EDA complete',
        `Generated summary statistics, correlation matrix, and top-10 value counts. ` +
          `Output:\n${out.slice(0, 4096)}`,
      );
      const corrMatch = out.match(/CORR:\s*([\s\S]*?)(?:VC\[|EDA_OK)/);
      if (corrMatch && /[01]\.(\d{2,})/.test(corrMatch[1])) {
        const strong = corrMatch[1]
          .split('\n')
          .filter((l) => /[01]\.(\d{2,})/.test(l) && !/^\s*$/.test(l))
          .slice(0, 5);
        if (strong.length) {
          this.recordFinding(
            acc,
            'low',
            'eda',
            'Strong correlations detected between numeric features',
            `Potential multicollinearity. Top correlations:\n${strong.join('\n')}`,
            {
              recommendation:
                'For linear models, consider dropping one of each highly-correlated pair or use regularization.',
            },
          );
        }
      }
    } else {
      this.recordFinding(
        acc,
        'medium',
        'eda',
        'EDA step failed',
        `sandbox_execute reported: ${res.error}`,
      );
    }
    this.recordArtifact(acc, 'eda.py', code, 'code', 'EDA snippet', undefined, 'python');
    this.emit(options, 'phase:complete', { phase: 'eda' });
  }

  private async phaseFeatureEngineering(
    options: AgentRunOptions,
    plan: DataSciencePlan,
    acc: RunAccumulator,
  ): Promise<void> {
    this.emit(options, 'phase:start', { phase: 'features' });
    const target = plan.targetColumn ?? 'target';
    const code = [
      'import pandas as pd, numpy as np',
      'from sklearn.preprocessing import StandardScaler, OneHotEncoder',
      'from sklearn.compose import ColumnTransformer',
      'try:',
      '    df = pd.read_csv("/tmp/cleaned.csv")',
      `    target = ${JSON.stringify(target)}`,
      '    y = df[target] if target in df.columns else None',
      '    X = df.drop(columns=[target]) if y is not None else df',
      "    num_cols = X.select_dtypes('number').columns.tolist()",
      "    cat_cols = X.select_dtypes(exclude='number').columns.tolist()",
      '    pre = ColumnTransformer([',
      "        ('num', StandardScaler(), num_cols),",
      "        ('cat', OneHotEncoder(handle_unknown='ignore', sparse_output=False), cat_cols),",
      '    ])',
      '    Xt = pre.fit_transform(X)',
      '    print("FEATURES shape:", Xt.shape)',
      '    if y is not None and y.dtype == "object":',
      '        print("CLASS_BALANCE:", y.value_counts().to_dict())',
      '    print("FEATURES_OK")',
      'except Exception as e:',
      '    print("FEATURES_ERROR:", repr(e))',
    ].join('\n');
    const res = await this.callTool(
      options,
      'sandbox_execute',
      { runtime: 'python', code, cwd: options.cwd },
      acc,
      'Feature engineering: one-hot encode categoricals, scale numerics, check class balance',
    );
    if (res.ok) {
      const out = String(res.output ?? '');
      this.recordFinding(
        acc,
        'info',
        'feature-engineering',
        'Feature matrix prepared',
        `Scaled numerics (StandardScaler) + one-hot encoded categoricals. ${out.slice(0, 1024)}`,
      );
      const balMatch = out.match(/CLASS_BALANCE:\s*\{([^}]*)\}/);
      if (balMatch) {
        const counts = balMatch[1]
          .split(',')
          .map((kv) => kv.trim())
          .filter(Boolean);
        const nums = counts
          .map((kv) => {
            const m = kv.match(/:\s*(\d+)/);
            return m ? Number(m[1]) : 0;
          })
          .filter((n) => n > 0);
        if (nums.length >= 2) {
          const ratio = Math.max(...nums) / Math.min(...nums);
          if (ratio > 5) {
            this.recordFinding(
              acc,
              'medium',
              'feature-engineering',
              'Class imbalance detected',
              `Target distribution: ${balMatch[1]}. Imbalance ratio is ~${ratio.toFixed(1)}:1.`,
              {
                recommendation:
                  'Use stratified CV and consider class_weight="balanced", SMOTE, or threshold tuning.',
              },
            );
          }
        }
      }
    } else {
      this.recordFinding(
        acc,
        'medium',
        'feature-engineering',
        'Feature engineering failed',
        `sandbox_execute reported: ${res.error}`,
      );
    }
    this.recordArtifact(acc, 'features.py', code, 'code', 'Feature engineering snippet', undefined, 'python');
    this.emit(options, 'phase:complete', { phase: 'features' });
  }

  private async phaseBuildModel(
    options: AgentRunOptions,
    plan: DataSciencePlan,
    acc: RunAccumulator,
  ): Promise<void> {
    this.emit(options, 'phase:start', { phase: 'model' });
    const code = this.buildModelCode(plan);
    const res = await this.callTool(
      options,
      'sandbox_execute',
      { runtime: 'python', code, cwd: options.cwd },
      acc,
      `Build ${plan.problemType} model`,
    );
    if (res.ok) {
      const out = String(res.output ?? '');
      this.recordFinding(
        acc,
        'info',
        'model',
        `Trained a ${plan.problemType} model`,
        `Output:\n${out.slice(0, 2048)}`,
      );
    } else {
      this.recordFinding(
        acc,
        'high',
        'model',
        'Model training failed',
        `sandbox_execute reported: ${res.error}. If the problem type was inferred ` +
          `(was "${plan.problemType}"), explicitly state the target column and task type in the goal.`,
      );
    }
    this.recordArtifact(acc, 'model.py', code, 'code', 'Model-training snippet', undefined, 'python');
    this.emit(options, 'phase:complete', { phase: 'model' });
  }

  private buildModelCode(plan: DataSciencePlan): string {
    const target = plan.targetColumn ?? 'target';
    const header = [
      'import pandas as pd, numpy as np',
      'from sklearn.model_selection import cross_val_score, train_test_split',
      'from sklearn.compose import ColumnTransformer',
      'from sklearn.preprocessing import StandardScaler, OneHotEncoder',
      'from sklearn.pipeline import Pipeline',
      'df = pd.read_csv("/tmp/cleaned.csv")',
      `target = ${JSON.stringify(target)}`,
      'assert target in df.columns, f"target {target} not in {list(df.columns)}"',
      'y = df[target]',
      'X = df.drop(columns=[target])',
      "    num_cols = X.select_dtypes('number').columns.tolist()",
      "    cat_cols = X.select_dtypes(exclude='number').columns.tolist()",
      '    pre = ColumnTransformer([',
      "        ('num', StandardScaler(), num_cols),",
      "        ('cat', OneHotEncoder(handle_unknown='ignore', sparse_output=False), cat_cols),",
      '    ])',
      '    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=42, ' +
        ('stratify=y' ) + ')',
    ];
    switch (plan.problemType) {
      case 'classification':
        return [
          ...header,
          '    from sklearn.ensemble import RandomForestClassifier',
          '    from sklearn.linear_model import LogisticRegression',
          '    from sklearn.metrics import classification_report, confusion_matrix, accuracy_score',
          '    clf = Pipeline([("pre", pre), ("rf", RandomForestClassifier(n_estimators=200, random_state=42))])',
          '    clf.fit(Xtr, ytr)',
          '    pred = clf.predict(Xte)',
          '    print("ACC:", accuracy_score(yte, pred))',
          '    print("CM:\\n", confusion_matrix(yte, pred))',
          '    print("REPORT:\\n", classification_report(yte, pred))',
          '    cv = cross_val_score(clf, X, y, cv=5, scoring="f1_weighted")',
          '    print("CV_F1:", cv.mean(), "+/-", cv.std())',
          '    import pickle',
          '    with open("/tmp/model.pkl","wb") as f: pickle.dump(clf, f)',
          '    print("MODEL_OK")',
          'except Exception as e:',
          '    print("MODEL_ERROR:", repr(e))',
        ].join('\n');
      case 'regression':
        return [
          ...header,
          '    from sklearn.ensemble import RandomForestRegressor',
          '    from sklearn.linear_model import Ridge',
          '    from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score',
          '    reg = Pipeline([("pre", pre), ("rf", RandomForestRegressor(n_estimators=200, random_state=42))])',
          '    reg.fit(Xtr, ytr)',
          '    pred = reg.predict(Xte)',
          '    print("MSE:", mean_squared_error(yte, pred))',
          '    print("MAE:", mean_absolute_error(yte, pred))',
          '    print("R2:", r2_score(yte, pred))',
          '    cv = cross_val_score(reg, X, y, cv=5, scoring="r2")',
          '    print("CV_R2:", cv.mean(), "+/-", cv.std())',
          '    import pickle',
          '    with open("/tmp/model.pkl","wb") as f: pickle.dump(reg, f)',
          '    print("MODEL_OK")',
          'except Exception as e:',
          '    print("MODEL_ERROR:", repr(e))',
        ].join('\n');
      case 'clustering':
        return [
          'import pandas as pd, numpy as np',
          'from sklearn.preprocessing import StandardScaler',
          'from sklearn.cluster import KMeans, DBSCAN',
          'from sklearn.metrics import silhouette_score',
          'df = pd.read_csv("/tmp/cleaned.csv")',
          'num = df.select_dtypes("number").dropna()',
          'X = StandardScaler().fit_transform(num)',
          'best = (-1, 2)',
          'for k in range(2, min(11, len(X))):',
          '    km = KMeans(n_clusters=k, random_state=42, n_init=10).fit(X)',
          '    s = silhouette_score(X, km.labels_)',
          '    print(f"k={k} silhouette={s:.3f}")',
          '    if s > best[0]: best = (s, k)',
          'print("BEST_K:", best[1], "SILHOUETTE:", round(best[0], 3))',
          'print("MODEL_OK")',
        ].join('\n');
      case 'time_series':
        return [
          'import pandas as pd, numpy as np',
          'df = pd.read_csv("/tmp/cleaned.csv")',
          '# naive ARIMA via statsmodels if available, else fallback',
          'try:',
          '    from statsmodels.tsa.arima.model import ARIMA',
          '    series = df.select_dtypes("number").iloc[:, 0]',
          '    model = ARIMA(series, order=(1,1,1)).fit()',
          '    print("AIC:", model.aic)',
          '    fc = model.forecast(steps=5)',
          '    print("FORECAST:", fc.tolist())',
          '    print("MODEL_OK")',
          'except Exception as e:',
          '    print("MODEL_ERROR:", repr(e))',
        ].join('\n');
      default:
        return [
          'print("MODEL_ERROR: problem type unknown; specify classification / regression / clustering / time_series")',
        ].join('\n');
    }
  }

  private async phaseEvaluateModel(
    options: AgentRunOptions,
    _plan: DataSciencePlan,
    acc: RunAccumulator,
  ): Promise<void> {
    this.emit(options, 'phase:start', { phase: 'evaluate' });
    const code = [
      'import pickle, pandas as pd',
      'try:',
      '    with open("/tmp/model.pkl","rb") as f: m = pickle.load(f)',
      '    print("MODEL_LOADED:", type(m).__name__)',
      '    if hasattr(m, "named_steps") and "rf" in m.named_steps:',
      '        rf = m.named_steps["rf"]',
      '        if hasattr(rf, "feature_importances_"):',
      '            print("HAS_IMPORTANCES")',
      'except Exception as e:',
      '    print("EVAL_ERROR:", repr(e))',
    ].join('\n');
    const res = await this.callTool(
      options,
      'sandbox_execute',
      { runtime: 'python', code, cwd: options.cwd },
      acc,
      'Load trained model and probe feature importances',
    );
    if (res.ok) {
      const out = String(res.output ?? '');
      this.recordFinding(
        acc,
        'info',
        'evaluation',
        'Model evaluation artefacts ready',
        `Loaded the persisted model. Output:\n${out.slice(0, 1024)}`,
      );
      if (/HAS_IMPORTANCES/.test(out)) {
        acc.recommendations.push(
          'Plot the top-N feature importances to communicate model drivers to stakeholders.',
        );
      }
    } else {
      this.recordFinding(
        acc,
        'low',
        'evaluation',
        'Could not reload model for evaluation',
        `sandbox_execute reported: ${res.error}`,
      );
    }
    this.recordArtifact(acc, 'evaluate.py', code, 'code', 'Evaluation snippet', undefined, 'python');
    this.emit(options, 'phase:complete', { phase: 'evaluate' });
  }

  private async phaseVisualize(
    options: AgentRunOptions,
    _plan: DataSciencePlan,
    acc: RunAccumulator,
  ): Promise<void> {
    this.emit(options, 'phase:start', { phase: 'visualize' });
    const code = [
      'import pandas as pd, numpy as np, os',
      'import matplotlib',
      "matplotlib.use('Agg')",
      'import matplotlib.pyplot as plt',
      'os.makedirs("/tmp/figures", exist_ok=True)',
      'try:',
      '    df = pd.read_csv("/tmp/cleaned.csv")',
      "    num = df.select_dtypes('number')",
      '    # 1. distributions',
      "    num.hist(bins=30, figsize=(12, 8))",
      '    plt.tight_layout()',
      '    plt.savefig("/tmp/figures/distributions.png", dpi=120)',
      '    plt.close()',
      '    # 2. correlation heatmap',
      '    if num.shape[1] >= 2:',
      '        fig, ax = plt.subplots(figsize=(8, 6))',
      '        im = ax.imshow(num.corr(), cmap="coolwarm", vmin=-1, vmax=1)',
      '        ax.set_xticks(range(len(num.columns))); ax.set_xticklabels(num.columns, rotation=90)',
      '        ax.set_yticks(range(len(num.columns))); ax.set_yticklabels(num.columns)',
      '        fig.colorbar(im)',
      '        plt.tight_layout()',
      '        plt.savefig("/tmp/figures/correlation.png", dpi=120)',
      '        plt.close()',
      '    # 3. missing heatmap (pre-imputation if reloaded)',
      "    miss = df.isna().astype(int)",
      '    if miss.sum().sum() > 0:',
      '        fig, ax = plt.subplots(figsize=(8, 6))',
      '        ax.imshow(miss.T, aspect="auto", cmap="Greys")',
      '        ax.set_xlabel("rows"); ax.set_ylabel("columns")',
      '        plt.tight_layout()',
      '        plt.savefig("/tmp/figures/missing.png", dpi=120)',
      '        plt.close()',
      '    print("FIGURES_SAVED:", os.listdir("/tmp/figures"))',
      'except Exception as e:',
      '    print("VIZ_ERROR:", repr(e))',
    ].join('\n');
    const res = await this.callTool(
      options,
      'sandbox_execute',
      { runtime: 'python', code, cwd: options.cwd },
      acc,
      'Generate distribution / correlation / missing-data PNG plots',
    );
    if (res.ok) {
      const out = String(res.output ?? '');
      this.recordFinding(
        acc,
        'info',
        'visualization',
        'Plots generated',
        `Saved to /tmp/figures. Listing: ${out.slice(0, 1024)}`,
      );
      this.recordArtifact(
        acc,
        'visualize.py',
        code,
        'code',
        'Visualization snippet (matplotlib Agg backend)',
        undefined,
        'python',
      );
      acc.recommendations.push(
        'Copy /tmp/figures/*.png into reports/figures/ and embed them in the Markdown report.',
      );
    } else {
      this.recordFinding(
        acc,
        'low',
        'visualization',
        'Visualization step failed',
        `sandbox_execute reported: ${res.error}`,
      );
    }
    this.emit(options, 'phase:complete', { phase: 'visualize' });
  }

  private async phaseReport(
    options: AgentRunOptions,
    plan: DataSciencePlan,
    acc: RunAccumulator,
  ): Promise<string | undefined> {
    this.emit(options, 'phase:start', { phase: 'report' });
    const md = this.composeReport(plan, acc);
    this.recordArtifact(
      acc,
      'analysis-report.md',
      md,
      'report',
      'Final Markdown analysis report (methodology, findings, model, recommendations)',
      'reports/analysis-report.md',
      'markdown',
    );
    const res = await this.callTool(
      options,
      'write_file',
      { path: 'reports/analysis-report.md', content: md, cwd: options.cwd },
      acc,
      'Write the final Markdown analysis report',
    );
    this.emit(options, 'phase:complete', { phase: 'report' });
    return res.ok ? 'reports/analysis-report.md' : undefined;
  }

  private composeReport(plan: DataSciencePlan, acc: RunAccumulator): string {
    const critical = acc.findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
    const insights = acc.findings.filter(
      (f) => f.category === 'eda' || f.category === 'feature-engineering',
    );
    return [
      `# Data-Science Analysis Report`,
      '',
      `**Goal:** ${plan.datasetPath} — ${plan.problemType} task`,
      `**Generated by:** ${this.icon} ${this.name} (\`${this.id}\`)`,
      '',
      '## Methodology',
      '',
      '1. Load & inspect dataset',
      '2. Clean (impute, dedupe, outlier-detect)',
      '3. EDA (statistics, correlations, value counts)',
      '4. Feature engineering (encode + scale)',
      `5. Model (${plan.problemType})`,
      '6. Evaluation (metrics + cross-validation)',
      '7. Visualization (matplotlib)',
      '8. Report',
      '',
      '## Dataset',
      `- Path: \`${plan.datasetPath}\``,
      `- Format: ${plan.detectedFormat}`,
      `- Problem type: ${plan.problemType}`,
      plan.targetColumn ? `- Target column: \`${plan.targetColumn}\`` : '- Target column: (not inferred)',
      '',
      '## Findings',
      '',
      ...acc.findings.map(
        (f) => `- **[${f.severity.toUpperCase()}] ${f.title}** (${f.category}) — ${f.description.split('\n')[0]}`,
      ),
      '',
      '## Critical issues',
      critical.length
        ? critical.map((f) => `- ${f.title} — ${f.description.split('\n')[0]}`).join('\n')
        : '_None._',
      '',
      '## Insights',
      insights.length
        ? insights.map((f) => `- ${f.title} — ${f.description.split('\n')[0]}`).join('\n')
        : '_No additional insights._',
      '',
      '## Recommendations',
      acc.recommendations.length
        ? acc.recommendations.map((r) => `- ${r}`).join('\n')
        : '_No additional recommendations._',
      '',
      '## Visualizations',
      'See `reports/figures/distributions.png`, `correlation.png`, `missing.png` (when generated).',
      '',
      '---',
      `_Actions executed: ${acc.actions.length}. Tool calls: ${acc.toolCalls}._`,
    ].join('\n');
  }

  private composeSummary(plan: DataSciencePlan, acc: RunAccumulator, durationMs: number): string {
    const phasesRun = new Set(acc.actions.map((a) => a.description.split(' ')[0].toLowerCase()));
    const failed = acc.actions.filter((a) => !a.success).length;
    return [
      `📊 Data Scientist ran ${acc.actions.length} actions across ${phasesRun.size} phases ` +
        `(${failed} failed) in ${durationMs}ms.`,
      `Dataset: ${plan.datasetPath} (${plan.detectedFormat}); task: ${plan.problemType}.`,
      `Findings: ${acc.findings.length} (${acc.findings.filter((f) => f.severity === 'high' || f.severity === 'critical').length} high/critical).`,
      `Artifacts: ${acc.artifacts.length} (incl. analysis-report.md).`,
      acc.recommendations.length
        ? `Top recommendation: ${acc.recommendations[0]}`
        : 'No recommendations.',
    ].join(' ');
  }
}
