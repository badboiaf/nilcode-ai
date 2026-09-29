// Project naming. When a user sends a coding request without creating a
// project first, NILCODE names the project from the assignment instead of
// truncating the prompt: an AI title when a provider is available, and a
// deterministic heuristic fallback when it is not. Titles stay short,
// human-readable and semantic ("Online Clothing Store", "Website Business").

// Words that never lead a title (leading verbs/auxiliaries and filler).
const LEAD_NOISE =
  /^(create|build|make|design|develop|implement|write|generate|add|code|do|start|let|help|need|want|give|show|please|can|could|would|should|fix|fixed|change|update|improve|explain|i|we|you|it|using|use)\b/i;

// Generic filler that carries no meaning for a title (including fluff gerunds).
const FILLER = new Set([
  'a', 'an', 'the', 'my', 'our', 'me', 'for', 'with', 'without', 'some', 'new', 'and', 'or', 'to',
  'of', 'in', 'on', 'at', 'is', 'are', 'it', 'its', "it's", 'that', 'this', 'these', 'those',
  'using', 'use', 'please', 'can', 'you', 'i', 'we', 'should', 'would', 'could', 'will', 'be',
  'has', 'have', 'there', 'from', 'into', 'about', 'as', 'so', 'very', 'really', 'just',
  'selling', 'showcasing', 'displaying', 'handling', 'design', 'designing', 'styling',
]);

// Descriptive adjectives that would make a title fluffy.
const ADJECTIVES = new Set([
  'clean', 'modern', 'simple', 'nice', 'beautiful', 'responsive', 'professional', 'basic',
  'good', 'great', 'cool', 'small', 'little', 'quick', 'fast', 'easy', 'best', 'perfect',
]);

// Concrete product nouns worth leading with, in priority order.
const HEAD_NOUNS = [
  'website', 'store', 'shop', 'storefront', 'dashboard', 'portfolio', 'blog', 'app',
  'application', 'landing', 'site', 'page', 'marketplace', 'platform', 'manager', 'tracker',
  'editor', 'gallery', 'calculator', 'calendar', 'planner', 'inventory', 'crm', 'chat',
  'game', 'tool', 'booking', 'kanban', 'checker', 'generator', 'system',
];

// Turn any raw model output into a safe title, or null if unusable.
export function cleanProjectTitle(text) {
  let t = String(text || '').trim();
  if (!t) return null;
  t = t.replace(/^["'`*#\s]+|["'`*#\s.,;:!?]+$/g, '');
  t = t.replace(/^(title|project name|name)\s*:\s*/i, '');
  t = t.split('\n')[0].trim();
  t = t.replace(/\s+/g, ' ');
  if (t.length > 48) t = t.slice(0, 48).trimEnd();
  if (!t || !/^[\w &+.'-]+$/.test(t)) return null; // reject JSON scraps, punctuation soup
  const words = t.split(' ').filter(Boolean);
  if (words.length < 1 || words.length > 6) return null;
  return words.map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

// Deterministic fallback: pull the meaningful noun phrase out of the request.
// "Create a website for my business with a clean modern design." → "Website Business"
// "Build me an online store for selling clothing." → "Online Store"
// "Create a dashboard for managing my employees." → "Dashboard Managing Employees"-style
// semantic fragments; the AI cleanup pass (when available) polishes these.
export function heuristicProjectTitle(prompt) {
  const raw = String(prompt || '')
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const words = raw.filter((w) => !FILLER.has(w.toLowerCase()));

  // Prefer the noun phrase around the first product noun: one qualifying word
  // before it, the noun, then up to two meaningful words after — so "a website
  // for my business" → "Website Business" and "dashboard for managing my
  // employees" keeps its substance.
  const noun = words.findIndex((w) => HEAD_NOUNS.includes(w.toLowerCase()));
  let picked;
  if (noun >= 0) {
    // Adjacent head nouns form one compound ("landing page", "coffee shop
    // site") — extend the head leftward before picking modifiers.
    let nounStart = noun;
    while (nounStart > 0 && HEAD_NOUNS.includes(words[nounStart - 1].toLowerCase())) nounStart--;
    const compound = words.slice(nounStart, noun + 1);
    // English titles put modifiers before the head noun: "Online Clothing
    // Store", "Business Website". Take one qualifier from before the compound
    // and one meaningful complement after it (skipping other product nouns and
    // gerund fluff), then order them before the noun.
    const qual = (w) =>
      !FILLER.has(w.toLowerCase()) &&
      !ADJECTIVES.has(w.toLowerCase()) &&
      !LEAD_NOISE.test(w) &&
      !HEAD_NOUNS.includes(w.toLowerCase()) &&
      !(/ing$/i.test(w) && w.length > 6);
    const before = nounStart > 0 && qual(words[nounStart - 1]) ? [words[nounStart - 1]] : [];
    const after = words.slice(noun + 1).filter(qual).slice(0, 1);
    // At most one modifier before the compound; a directly adjacent qualifier
    // ("coffee shop") beats one from after ("… website with online ordering").
    picked = [...(before.length ? before : after), ...compound];
  } else {
    let start = 0;
    while (start < words.length - 1 && LEAD_NOISE.test(words[start])) start++;
    picked = words.slice(start);
  }
  // Drop leading verbs and fluffy adjectives, but keep at least one word.
  while (picked.length > 1 && (LEAD_NOISE.test(picked[0]) || ADJECTIVES.has(picked[0].toLowerCase()))) picked.shift();
  if (!picked.length) picked = words.slice(0, 2);
  const title = picked.slice(0, 4).join(' ') || 'New Project';
  return cleanProjectTitle(title) || 'New Project';
}
