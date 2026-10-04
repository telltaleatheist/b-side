import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** One palette: the ground and two inks. */
interface Palette {
  readonly ground: string;
  readonly deep: string;
  readonly ink: string;
  readonly glow: string;
}

const PALETTES: readonly Palette[] = [
  { ground: '#0e1430', deep: '#1a1033', ink: '#f2a541', glow: '#22d3ee' },
  { ground: '#0c1d22', deep: '#082a33', ink: '#67e8f9', glow: '#22d3ee' },
  { ground: '#141210', deep: '#2a2520', ink: '#22d3ee', glow: '#f4efe6' },
  { ground: '#2a160c', deep: '#3a2414', ink: '#f2a541', glow: '#c7782b' },
  { ground: '#161310', deep: '#083344', ink: '#67e8f9', glow: '#f4efe6' },
  { ground: '#1d1029', deep: '#2b1640', ink: '#fb7185', glow: '#f2a541' },
  { ground: '#0f1a12', deep: '#16301d', ink: '#a3e635', glow: '#22d3ee' },
  { ground: '#1a1414', deep: '#2b1c1c', ink: '#f4efe6', glow: '#fb7185' },
];

type Pattern = 'sun' | 'rain' | 'rings' | 'stripes' | 'tide' | 'deck';
const PATTERNS: readonly Pattern[] = ['sun', 'rain', 'rings', 'stripes', 'tide', 'deck'];

/** FNV-1a, so the same key always draws the same cover. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A layer: one absolutely placed box with its own background. */
interface Layer {
  readonly style: string;
}

/**
 * The cover every song, playlist and album gets before (or instead of) a
 * painted one: drawn from its key, so the same song always has the same art,
 * with nothing to fetch and no server. The patterns are the design canvas's
 * (a sun over a grid, rain at a window, rings, record stripes, a tide, a deck),
 * in Night Deck's palettes. A painted cover (`src`) replaces it when there is one.
 */
@Component({
  selector: 'app-cover',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (src(); as url) {
      <img [src]="url" alt="" draggable="false" />
    } @else {
      <div class="ground" [style]="ground()"></div>
      @for (layer of layers(); track $index) {
        <div class="layer" [style]="layer.style"></div>
      }
    }
  `,
  styles: [`
    :host { position: relative; display: block; overflow: hidden; aspect-ratio: 1; border-radius: var(--cover-radius, 6px); flex: none; background: #12100e; }
    .ground, .layer { position: absolute; inset: 0; }
    img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  `],
})
export class CoverComponent {
  /** What the art is drawn from: a song's or playlist's id, plus its tags if any. */
  readonly key = input.required<string>();
  /** A painted cover, when there is one. */
  readonly src = input<string | null>(null);

  private readonly seed = computed(() => hash(this.key()));
  private readonly palette = computed(() => PALETTES[this.seed() % PALETTES.length] as Palette);
  private readonly pattern = computed(() => PATTERNS[(this.seed() >>> 8) % PATTERNS.length] as Pattern);
  /** 0..1, for placement and angles. */
  private readonly wobble = computed(() => ((this.seed() >>> 16) % 1000) / 1000);

  protected readonly ground = computed(() => {
    const p = this.palette();
    return this.pattern() === 'sun'
      ? `background: linear-gradient(180deg, ${p.ground} 0%, ${p.deep} 55%, #0b0a09 56%)`
      : `background: ${p.ground}`;
  });

  protected readonly layers = computed<Layer[]>(() => {
    const p = this.palette();
    const w = this.wobble();
    switch (this.pattern()) {
      case 'sun':
        return [
          { style: `left: ${27 + w * 10}%; top: ${18 + w * 8}%; width: 46%; height: 46%; inset: auto; border-radius: 50%; background: repeating-linear-gradient(180deg, ${p.ink} 0 9%, transparent 9% 13%)` },
          { style: `top: 56%; background: repeating-linear-gradient(90deg, ${p.glow}88 0 1px, transparent 1px 12.5%), repeating-linear-gradient(180deg, ${p.glow}88 0 1px, transparent 1px 18%); transform: perspective(120px) rotateX(48deg); transform-origin: top` },
        ];
      case 'rain':
        return [
          { style: `background: repeating-linear-gradient(${95 + w * 15}deg, transparent 0 7px, ${p.ink}59 7px 8px)` },
          { style: `inset: auto 12% 14% 12%; height: ${28 + w * 14}%; border: 2px solid ${p.glow}; border-bottom: none; border-radius: 4px 4px 0 0; box-shadow: 0 0 18px ${p.glow}99` },
        ];
      case 'rings':
        return [
          { style: `background: radial-gradient(circle at ${40 + w * 20}% ${40 + w * 20}%, ${p.ink} 0 6%, transparent 6.5%), repeating-radial-gradient(circle at ${40 + w * 20}% ${40 + w * 20}%, ${p.ground} 0 5px, ${p.deep} 5px 6px)` },
        ];
      case 'stripes':
        return [
          { style: `background: repeating-linear-gradient(${120 + w * 40}deg, ${p.ink} 0 14px, ${p.glow} 14px 28px, ${p.deep} 28px 42px)` },
          { style: `inset: 30%; border-radius: 50%; background: #12100e; box-shadow: 0 0 0 6px #12100e, 0 0 0 8px ${p.ink}` },
        ];
      case 'tide':
        return [
          { style: `inset: auto -10% -38% -10%; height: 90%; border-radius: 50%; background: radial-gradient(circle at 50% 0%, ${p.ink}, ${p.deep} 60%, ${p.ground})` },
          { style: `inset: auto; left: ${12 + w * 50}%; top: 18%; width: 22%; height: 22%; border-radius: 50%; background: ${p.glow}` },
        ];
      case 'deck':
        return [
          { style: `background: conic-gradient(from ${180 + w * 90}deg at 50% 60%, #0b0a09, ${p.ink} 25%, #0b0a09 50%, ${p.glow} 75%, #0b0a09)` },
          { style: `background: repeating-linear-gradient(0deg, rgba(11,10,9,.55) 0 2px, transparent 2px 5px)` },
        ];
    }
  });
}
