import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Brief } from '../contracts.ts';

// The system text for a purpose: the rules file plus the brief. Built with a fixed key order and no
// timestamps so it is byte-identical across calls and the prompt cache holds.
export function systemPrompt(purpose: 'hooks' | 'script' | 'claims' | 'copy' | 'copycheck', brief: Brief): string {
  const rules = readFileSync(join(import.meta.dirname, '../../prompts', `${purpose}.md`), 'utf8').trimEnd();
  const b = {
    shop: { name: brief.shop.name, domain: brief.shop.domain, currency: brief.shop.currency, shipsTo: brief.shop.shipsTo },
    product: { handle: brief.product.handle, title: brief.product.title, url: brief.product.url, type: brief.product.type, priceText: brief.product.priceText, colors: brief.product.colors },
    facts: brief.facts.map((f) => ({ id: f.id, text: f.text })),
    disclosures: brief.disclosures,
    angles: brief.angles,
    shots: brief.shots.map((s) => ({ id: s.id, kind: s.kind, variant: s.variant, note: s.note })),
    rules: { discountClaims: brief.rules.discountClaims, reviewClaims: brief.rules.reviewClaims },
  };
  return `${rules}\n\n<brief>\n${JSON.stringify(b, null, 1)}\n</brief>`;
}
