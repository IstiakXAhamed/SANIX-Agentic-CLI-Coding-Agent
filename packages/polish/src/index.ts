/**
 * @file index.ts
 * @description Barrel export for `@sanix/polish`.
 *
 * @packageDocumentation
 */

export * as ansi from './ansi.js';
export type { RGB } from './ansi.js';
export { setColorEnabled, isColorEnabled, stripAnsi, visibleWidth, glow, breathe, brightRgb, dimRgb, breathDots } from './ansi.js';
export type { BreathPhase } from './ansi.js';
export * as brand from './brand.js';
export { SANIX_PALETTE, SANIX_LOGO, SANIX_TAGLINE, SANIX_VERSION_LINE } from './brand.js';
export { AnimatedSpinner } from './AnimatedSpinner.js';
export type { AnimatedSpinnerOptions, SpinnerStyle, SpinnerScene } from './AnimatedSpinner.js';
export { ProgressBar, MultiProgress } from './ProgressBar.js';
export type { ProgressBarOptions } from './ProgressBar.js';
export { OnboardingWizard } from './OnboardingWizard.js';
export type { OnboardingWizardOptions, WizardResult, WizardStep, WizardAnswers, WizardPrompt } from './OnboardingWizard.js';
export { ErrorFormatter, renderRoundedBox, stripForLog } from './ErrorFormatter.js';
export type { ErrorFormatterOptions } from './ErrorFormatter.js';
export { BannerRenderer } from './BannerRenderer.js';
export type { BannerRenderOptions, BannerAnimation } from './BannerRenderer.js';
export { StatusLine, coloredSection, boldSection } from './StatusLine.js';
export type { StatusLineOptions, StatusLineState, StatusMode } from './StatusLine.js';
export { TableRenderer } from './TableRenderer.js';
export type { TableRenderOptions, TableTheme, TableRow } from './TableRenderer.js';
export { Confetti } from './Confetti.js';
export type { ConfettiOptions } from './Confetti.js';
export { ToastManager } from './Toast.js';
export type { ToastManagerOptions, ToastOptions, ToastSeverity } from './Toast.js';
