/**
 * fresh-names — keeps the names the writers give from circling the same few images.
 *
 * Owen, 2026-10-11: "for metal, it has an obsession with crowns, ash, and iron. and cathedrals.
 * and burning ... when i generated soul music it was obsessed with velvet" (Victoria saw the same).
 * Each call that names something is told the words already worn (the library's recent names, and
 * the ones every model reaches for) and given a random spark to start somewhere else.
 */

/** Words models reach for in a genre's names, whatever the library holds. */
const WORN_ALWAYS = [
  'crown', 'ash', 'iron', 'cathedral', 'burn', 'burning', 'throne', 'ember', 'flame', 'fire', 'blood', 'steel',
  'shadow', 'raven', 'abyss', 'eternal', 'velvet', 'midnight', 'neon', 'echo', 'whisper', 'ghost', 'golden',
  'silver', 'storm', 'thunder', 'starlight', 'heart', 'soul', 'dream',
];

/** Words too small to count as an image. */
const SMALL = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'under', 'that', 'this', 'your', 'you', 'our', 'his', 'her',
  'its', 'all', 'not', 'are', 'was', 'one', 'out', 'off', 'who', 'what', 'when', 'where', 'how', 'why', 'than', 'then',
  'bside', 'track', 'song', 'part',
]);

/** Concrete, unrelated things: two are offered as a starting spark, used freely or loosely. */
const SPARKS = [
  'laundromat', 'ferry', 'radio tower', 'orchard', 'parking lot', 'lighthouse keeper', 'postcard', 'tide pool', 'bus depot',
  'greenhouse', 'switchyard', 'night shift', 'paper kite', 'motel sign', 'grain silo', 'rooftop', 'canal lock', 'thrift store',
  'snow plow', 'quarry', 'ice rink', 'payphone', 'lemon tree', 'hailstorm', 'marching band', 'lumberyard', 'subway car',
  'drive-in', 'beehive', 'dry riverbed', 'fishing boat', 'water tower', 'dance hall', 'tin roof', 'cable car', 'salt flat',
  'locksmith', 'carnival', 'antenna', 'old map', 'compass', 'typewriter', 'tollbooth', 'wolf pack', 'harbor crane',
  'glacier', 'vending machine', 'radio static', 'mile marker', 'sawmill', 'pinball', 'telescope', 'fire escape',
  'wheat field', 'steam engine', 'pocket watch', 'jukebox', 'scarecrow', 'cliff diver', 'night market', 'sandstorm',
  'hornet', 'clock repair', 'satellite', 'rain gauge', 'chess clock', 'tugboat', 'swimming pool', 'mountain pass',
  'shipwreck', 'sparrow', 'boxing ring', 'blueprint', 'freight elevator', 'border town', 'switchblade', 'fog horn',
  'iceberg', 'sunflower', 'wrecking ball', 'paper mill', 'airstrip', 'tram line', 'copper wire', 'bonfire night',
];

/** A word as the namer would reuse it: lower case, letters only, a plain plural made singular. */
function stem(word: string): string {
  const plain = word.toLowerCase().replace(/[^a-z]/g, '');
  if (/(ches|shes|sses|xes)$/.test(plain)) return plain.slice(0, -2);
  if (/[^s]s$/.test(plain) && plain.length > 3) return plain.slice(0, -1);
  return plain;
}

/** The words the library's recent names lean on: each used in at least two of them. */
export function wornWords(names: readonly string[], most = 20): string[] {
  const counts = new Map<string, number>();
  for (const name of names) {
    const words = new Set(name.split(/[\s\-–—:,.!?'"()/&·]+/).map(stem).filter((word) => word.length >= 3 && !SMALL.has(word)));
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, most).map(([word]) => word);
}

/**
 * The line every naming call is given: the worn words (never in the name, nor their forms) and a
 * spark. `names` are the library's most recent names, newest first; `random` is injectable for tests.
 */
export function freshLine(names: readonly string[], random: () => number = Math.random): string {
  const worn = [...new Set([...wornWords(names), ...WORN_ALWAYS])];
  const pick = (): string => SPARKS[Math.floor(random() * SPARKS.length)] as string;
  const first = pick();
  let second = pick();
  for (let tries = 0; second === first && tries < 5; tries++) second = pick();
  return [
    `Worn out, never in a name (nor their forms, unless the person's own words ask for them): ${worn.join(', ')}.`,
    `A spark to start somewhere new, used freely or loosely: ${first}, ${second}.`,
  ].join('\n');
}
