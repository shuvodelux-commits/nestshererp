/**
 * The six summary-tile tones of §2.7.I, chosen by **meaning** rather than
 * taste: money in is blue, cost is slate, profit is green, something needing
 * attention is amber, a receivable is violet, a payable is rose.
 *
 * The type lives here rather than in `StatCard.vue` so a module can name a tone
 * — in a table of planned tiles, in a config object — without importing a
 * component it does not render. The values themselves are `tokens.css`.
 */
export type StatTone = 'blue' | 'slate' | 'green' | 'amber' | 'violet' | 'rose';
