import { SANIX_PALETTE, SPINNER_INTERVAL_MS } from './brand.js';
import {
  cursorToCol0, clearLine, rgb, hideCursor, showCursor,
  glow, breathe, brightRgb,
  type RGB, type BreathPhase,
} from './ansi.js';

/* ── Style frames (backward-compat with the original 5) ─────────── */

export type SpinnerStyle = 'dots' | 'bar' | 'earth' | 'moon' | 'pulse';

const STYLE_FRAMES: Readonly<Record<SpinnerStyle, readonly string[]>> = {
  dots:  ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  bar:   ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'],
  earth: ['🌍', '🌎', '🌏'],
  moon:  ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
  pulse: ['◐', '◓', '◑', '◒'],
};

const STYLE_COLOR: Readonly<Record<SpinnerStyle, RGB>> = {
  dots:  SANIX_PALETTE.teal,
  bar:   SANIX_PALETTE.amber,
  earth: SANIX_PALETTE.violet,
  moon:  SANIX_PALETTE.rose,
  pulse: SANIX_PALETTE.teal,
};

/* ── 18 Scenarios ───────────────────────────────────────────────── */

export type SpinnerScene =
  | 'boot'        | 'thinking'   | 'planning'   | 'searching'
  | 'streaming'   | 'loading'    | 'connecting'  | 'analyzing'
  | 'compiling'   | 'processing' | 'saving'      | 'fetching'
  | 'generating'  | 'installing' | 'optimizing'  | 'waiting'
  | 'error'       | 'tool';

/** A scene definition: which frame set + color + default text to use. */
interface SceneDef {
  readonly frames: readonly string[];
  readonly color: RGB;
  readonly text: string;
  readonly intervalMs?: number;
}

const SCENES: Readonly<Record<SpinnerScene, SceneDef>> = {
  boot:       { frames: ['🚀', '🔄', '🔧', '🔄'], color: SANIX_PALETTE.teal,  text: 'Booting SANIX…' },
  thinking:   { frames: ['🧠', '💭', '✨', '💭'], color: SANIX_PALETTE.violet, text: 'Thinking…' },
  planning:   { frames: ['📋', '📝', '📋', '📝', '✅', '📝'], color: SANIX_PALETTE.amber, text: 'Planning…' },
  searching:  { frames: ['🔍', '🔎', '🔍', '🔎', '📂', '🔎'], color: { r: 34, g: 211, b: 238 }, text: 'Searching…' },
  streaming:  { frames: ['〰️', '➰', '〰️', '➿', '〰️'], color: SANIX_PALETTE.teal,  text: 'Streaming…', intervalMs: 60 },
  loading:    { frames: ['⏳', '⌛', '⏳', '⌛'], color: SANIX_PALETTE.teal,  text: 'Loading…' },
  connecting: { frames: ['🔗', '⛓️', '🔗', '🌐', '🔗'], color: { r: 34, g: 211, b: 238 }, text: 'Connecting…' },
  analyzing:  { frames: ['🔬', '🧪', '🔬', '📊', '🔬'], color: SANIX_PALETTE.violet, text: 'Analyzing…' },
  compiling:  { frames: ['⚙️', '🔩', '⚙️', '🛠️', '⚙️'], color: { r: 250, g: 204, b: 21 }, text: 'Compiling…' },
  processing: { frames: ['🌀', '♻️', '🌀', '⚡', '🌀'], color: SANIX_PALETTE.violet, text: 'Processing…' },
  saving:     { frames: ['💾', '📀', '💾', '✅', '💾'], color: { r: 57, g: 211, b: 83 }, text: 'Saving…' },
  fetching:   { frames: ['📥', '⬇️',  '📩', '⬇️', '📥'], color: { r: 34, g: 211, b: 238 }, text: 'Fetching…' },
  generating: { frames: ['✨', '🌟', '⭐', '🌟', '✨', '💫'], color: SANIX_PALETTE.amber, text: 'Generating…' },
  installing: { frames: ['📦', '📥', '📦', '🔧', '📦'], color: SANIX_PALETTE.amber, text: 'Installing…' },
  optimizing: { frames: ['🔧', '⚡', '🔧', '📈', '🔧'], color: { r: 57, g: 211, b: 83 }, text: 'Optimizing…' },
  waiting:    { frames: ['⏳', '⏳', '⌛', '⏳'], color: SANIX_PALETTE.teal,  text: 'Waiting…', intervalMs: 200 },
  error:      { frames: ['❌', '⚠️',  '❗', '⚠️', '❌'], color: SANIX_PALETTE.rose, text: 'Error — retrying…' },
  tool:       { frames: ['🔨', '🛠️',  '🔧', '🛠️', '🔨'], color: SANIX_PALETTE.teal,  text: 'Running tool…' },
};

/* ── Breathing-glow cycle for text ───────────────────────────────── */

/**
 * How many render-cycles per breath (full in→hold→out→hold).
 * E.g. 4 cycles in, 2 hold, 4 out, 2 hold = 12 total.
 */
const GLOW_CYCLE: BreathPhase[] = [
  'in', 'in', 'in', 'in',        // breathe in (bright)
  'hold', 'hold',                 // hold
  'out', 'out', 'out', 'out',    // breathe out (dim)
  'hold', 'hold',                 // hold
];

/* ── Options ────────────────────────────────────────────────────── */

export interface AnimatedSpinnerOptions {
  /** Frame-set style (ignored when `scene` is set). Default `dots`. */
  style?: SpinnerStyle;
  /** Scenario — auto-selects frames + color + default text. */
  scene?: SpinnerScene;
  /** Frame interval ms. Default 80. */
  intervalMs?: number;
  /** Output stream. Default `process.stderr`. */
  stream?: { write: (s: string) => void };
  /** Whether to hide the cursor while spinning. Default true. */
  hideCursorWhileSpinning?: boolean;
  /** Enable breathing-glow effect on the status text. Default true. */
  glow?: boolean;
  /** The status text shown beside the spinner. */
  text?: string;
}

/* ── The Spinner ────────────────────────────────────────────────── */

export class AnimatedSpinner {
  private readonly style: SpinnerStyle;
  private readonly scene: SpinnerScene | undefined;
  private readonly intervalMs: number;
  private readonly stream: { write: (s: string) => void };
  private readonly hideCursorWhileSpinning: boolean;
  private readonly enableGlow: boolean;
  private text: string;
  private timer?: ReturnType<typeof setInterval>;
  private frameIdx = 0;
  private glowIdx = 0;

  constructor(opts: AnimatedSpinnerOptions & { text?: string } = {}) {
    // If a scene is given, derive style + text from it (unless overridden).
    if (opts.scene && SCENES[opts.scene]) {
      const def = SCENES[opts.scene];
      this.scene = opts.scene;
      this.style = 'dots'; // scene uses its own frames — style is unused
      this.intervalMs = opts.intervalMs ?? def.intervalMs ?? SPINNER_INTERVAL_MS;
      this.text = opts.text ?? def.text;
    } else {
      this.style = opts.style ?? 'dots';
      this.intervalMs = opts.intervalMs ?? SPINNER_INTERVAL_MS;
      this.text = opts.text ?? '';
    }
    this.stream = opts.stream ?? process.stderr;
    this.hideCursorWhileSpinning = opts.hideCursorWhileSpinning ?? true;
    this.enableGlow = opts.glow ?? true;
  }

  /** Update the spinner's status text (without restarting it). */
  setText(text: string): void {
    this.text = text;
    if (this.timer) this.render();
  }

  /** Start spinning. */
  start(text?: string): void {
    if (text !== undefined) this.text = text;
    if (this.timer) return;
    if (this.hideCursorWhileSpinning) this.stream.write(hideCursor());
    this.frameIdx = 0;
    this.glowIdx = 0;
    this.render();
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % this.currentFrames().length;
      this.glowIdx = (this.glowIdx + 1) % GLOW_CYCLE.length;
      this.render();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop spinning and clear the line. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.stream.write(clearLine() + cursorToCol0());
    if (this.hideCursorWhileSpinning) this.stream.write(showCursor());
  }

  /** Stop with a green check mark and `text`. */
  succeed(text?: string): void {
    this.stop();
    if (text !== undefined) this.text = text;
    this.stream.write(`${rgb('✓', { r: 45, g: 212, b: 191 })} ${this.text}\n`);
  }

  /** Stop with a red X and `text`. */
  fail(text?: string): void {
    this.stop();
    if (text !== undefined) this.text = text;
    this.stream.write(`${rgb('✗', { r: 251, g: 113, b: 133 })} ${this.text}\n`);
  }

  /** Stop with an amber warning and `text`. */
  warn(text?: string): void {
    this.stop();
    if (text !== undefined) this.text = text;
    this.stream.write(`${rgb('⚠', { r: 251, g: 191, b: 36 })} ${this.text}\n`);
  }

  /** Return the current frame glyph. */
  private currentFrame(): string {
    const frames = this.currentFrames();
    return frames[this.frameIdx % frames.length] ?? '';
  }

  /** Return the frame array for the current mode (scene wins). */
  private currentFrames(): readonly string[] {
    if (this.scene) return SCENES[this.scene].frames;
    return STYLE_FRAMES[this.style];
  }

  /** Return the color for the current mode. */
  private currentColor(): RGB {
    if (this.scene) return SCENES[this.scene].color;
    return STYLE_COLOR[this.style];
  }

  /** Render the current frame + (optionally glowing) text. */
  private render(): void {
    const frame = this.currentFrame();
    const color = this.currentColor();
    const phase = GLOW_CYCLE[this.glowIdx];

    // The frame glyph also glows with the breathing cycle
    const styledFrame = this.enableGlow
      ? breathe(frame, color, phase)
      : rgb(frame, color);

    // The status text breathes with the cycle
    const styledText = this.enableGlow
      ? breathe(this.text, color, phase)
      : rgb(this.text, color);

    // Write with optional bright-glow frame colour
    const fullLine = `${styledFrame} ${styledText}`;
    this.stream.write(clearLine() + cursorToCol0() + fullLine);
  }
}
