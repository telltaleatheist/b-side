/**
 * text-model — who answers B-Sides' text calls (describe's tags, an album's concept, track
 * list and regenerated pieces): one interface, two writers.
 *
 *   bside    B-Sides' own model (qwen3.5-4b-bside) on the Crucible server: crucibleText().
 *   claude   Claude Sonnet 5.5 through Claude Code on this computer (electron/claude-writer.ts),
 *            standing in for everything the B-Sides model does while it is retrained (Owen,
 *            2026-10-10: "until b-sides model is fully retrained lets make it so everything it
 *            would normally handle goes through claude -p"). Desktop only.
 *
 * Every call asks for JSON held to a schema and answers that JSON's text; the caller parses it.
 * The task tag (album-text.ts, "[album]" ...) is part of B-Sides' model's contract: crucibleText
 * puts it on the user message's first line, a writer that was never trained on it may leave it off.
 */
import { CrucibleRefused, type CrucibleClient } from '@crucible/client';

import { chatSeed } from './crucible';
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

/** B-Sides' own model on a Crucible server; `client` may be an album's session. */
export function crucibleText(client: CrucibleClient, model: string): TextModel {
  return {
    name: model,
    async ask(request) {
      try {
        const answer = await client.chat({
          model,
          thinking: false,
          temperature: request.temperature,
          seed: chatSeed(),
          maxTokens: request.maxTokens,
          act: 'generate',
          responseFormat: { type: 'json_schema', json_schema: { name: request.name, schema: request.schema as Record<string, unknown>, strict: true } },
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: `${request.tag}\n${request.user}` },
          ],
        });
        return { content: answer.content, truncated: answer.finishReason === 'length' };
      } catch (error) {
        if (error instanceof CrucibleRefused && error.code === 'installing') {
          // The model's first use: the server is downloading it. Say how far along, in its words.
          throw new Refusal('model_installing', `${model} is being set up on the server first: ${error.serverMessage}`, 409);
        }
        throw error;
      }
    },
  };
}
