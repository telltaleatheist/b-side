/**
 * text-model — who answers B-Sides' text calls (describe's tags, an album's concept, track
 * list and regenerated pieces): one interface, two writers.
 *
 *   bside    B-Sides' own model (qwen3.5-4b-bside) on the Crucible server: OFF while it is
 *            retrained (bsideModelOff); crucibleText() is a stub that refuses.
 *   claude   Claude Sonnet 5.5 through Claude Code on this computer (electron/claude-writer.ts),
 *            standing in for everything the B-Sides model does while it is retrained (Owen,
 *            2026-10-10: "until b-sides model is fully retrained lets make it so everything it
 *            would normally handle goes through claude -p"). Desktop only.
 *
 * Every call asks for JSON held to a schema and answers that JSON's text; the caller parses it.
 * The task tag (album-text.ts, "[album]" ...) is part of B-Sides' model's contract: crucibleText
 * puts it on the user message's first line, a writer that was never trained on it may leave it off.
 */
import type { CrucibleClient } from '@crucible/client';

import { Refusal } from './refusal';

/** Who writes; a hub preference. */
export type Writer = 'bside' | 'claude';
export const WRITERS: readonly Writer[] = ['bside', 'claude'];

/** One text call. */
export interface TextRequest {
  /** The task tag ("[describe]", "[album]", ...). */
  readonly tag: string;
  /** The schema's name. */
  readonly name: string;
  readonly system: string;
  /** The content after the tag line. */
  readonly user: string;
  readonly schema: object;
  readonly temperature: number;
  readonly maxTokens: number;
}

/** What came back: the JSON's text, and whether it was cut off at maxTokens. */
export interface TextAnswer {
  readonly content: string;
  readonly truncated: boolean;
}

export interface TextModel {
  /** The model, as B-Sides names who wrote something. */
  readonly name: string;
  ask(request: TextRequest): Promise<TextAnswer>;
}

/**
 * B-Sides' own model is off while it is retrained (Owen, 2026-11-06: "we want to remove and stub
 * calls to a local model"): nothing installs, loads or chats with it. Every place that would have
 * asked it refuses by name instead, before touching the server. Claude Code writes in its place.
 */
export function bsideModelOff(): never {
  throw new Refusal(
    'bside_model_off',
    "B-Sides' own writing model is off while it is retrained, so Claude Code on a B-Sides computer writes everything. "
      + 'Install Claude Code there and sign in (`claude auth login`).',
    503,
  );
}

/** Stubbed: B-Sides' own model is off (bsideModelOff); the server is never asked. */
export function crucibleText(_client: CrucibleClient, _model: string): TextModel {
  return bsideModelOff();
}
