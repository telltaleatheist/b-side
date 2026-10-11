import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import qrcode from 'qrcode-generator';

/** A QR code of `text`, drawn as one SVG path (dark modules on a light quiet zone, so phone cameras read it in dark mode too). */
@Component({
  selector: 'app-qr-code',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.viewBox]="'0 0 ' + code().size + ' ' + code().size" role="img" [attr.aria-label]="label()" shape-rendering="crispEdges">
      <rect [attr.width]="code().size" [attr.height]="code().size" fill="#fff" />
      <path [attr.d]="code().path" fill="#000" />
    </svg>
  `,
  styles: [`
    :host { display: block; width: 180px; }
    svg { display: block; width: 100%; height: auto; border-radius: 8px; }
  `],
})
export class QrCodeComponent {
  readonly text = input.required<string>();
  readonly label = input('QR code');

  protected readonly code = computed(() => {
    const qr = qrcode(0, 'M');
    qr.addData(this.text());
    qr.make();
    const count = qr.getModuleCount();
    const margin = 4;
    let path = '';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
    return { size: count + margin * 2, path };
  });
}
