import { Script, type Brief } from '../contracts.ts';
import type { Config } from '../config/index.ts';
import type { Db } from '../db/index.ts';
import { callJson } from '../llm/client.ts';
import { systemPrompt } from '../llm/prompts.ts';
import { checkScript, judgeClaims } from './claims.ts';
import type { Hook } from './hooks.ts';

export class ScriptRejectedError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`script rejected:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

function problemsOf(brief: Brief, script: Script, hook: Hook): string[] {
  const p = checkScript(brief, script);
  const first = script.beats[0]?.chunks[0];
  if (first && (first.say !== hook.say || first.show !== hook.headline)) p.push('the first hook chunk must be the given hook: say and show word for word');
  return p;
}

// Writes the script for a hook. Deterministic checks, then the claim judge; one retry with the problems listed.
export async function writeScript(db: Db, config: Config, brief: Brief, hook: Hook, now: Date, slotId: string): Promise<Script> {
  const base =
    `Write the script for this hook.\nframework: ${hook.framework}\nheadline (show): ${hook.headline}\nsay: ${hook.say}\nfactIds: ${hook.factIds.join(', ') || '(none)'}\n` +
    `Word budgets on say: hook at most 7, benefit 12 to 20, offer 4 to 9, cta 3 to 7, total 28 to 38.`;
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? base : `${base}\n\nYour previous attempt had these problems. Fix all of them:\n${problems.map((p) => `- ${p}`).join('\n')}`;
    const script = await callJson(
      db,
      config,
      { purpose: 'script', model: config.llm.models.script, system: systemPrompt('script', brief), user, schema: Script, maxTokens: 4000, effort: 'medium', slotId },
      now,
    );
    script.hook = { framework: hook.framework, headline: hook.headline };
    problems = problemsOf(brief, script, hook);
    if (!problems.length) problems = await judgeClaims(db, config, brief, script, now, slotId);
    if (!problems.length) return script;
  }
  throw new ScriptRejectedError(problems);
}
