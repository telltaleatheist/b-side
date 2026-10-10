import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'listen' | 'make' | 'library' | 'settings'
  | 'play' | 'pause' | 'next' | 'prev' | 'shuffle' | 'queue'
  | 'plus' | 'more' | 'down' | 'close' | 'trash' | 'save' | 'bookmark'
  | 'cloud' | 'download' | 'phone' | 'infinite' | 'chevron' | 'back' | 'edit' | 'repeat' | 'repeat-one' | 'grip' | 'queue-add' | 'play-next' | 'reroll';

/** Night Deck's icons: stroke drawings on a 24 grid, in the text colour. Decorative unless the button names itself. */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" aria-hidden="true"
         fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      @switch (name()) {
        @case ('listen') { <path d="M4 14a8 8 0 0 1 16 0"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/> }
        @case ('make') { <path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/> }
        @case ('library') { <rect x="3" y="7" width="13" height="13" rx="2"/><path d="M7 4h12a2 2 0 0 1 2 2v12"/> }
        @case ('settings') { <circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/> }
        @case ('play') { <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/> }
        @case ('pause') { <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/> }
        @case ('next') { <path d="M5 5.5v13l9-6.5zM16 5.5h2.5v13H16z" fill="currentColor" stroke="none"/> }
        @case ('prev') { <path d="M19 5.5v13l-9-6.5zM8 5.5H5.5v13H8z" fill="currentColor" stroke="none"/> }
        @case ('shuffle') { <path d="M3 7h3c4 0 6 10 10 10h4M3 17h3c1.5 0 2.7-1.4 3.8-3.3M14 8.5C14.9 7.6 15.9 7 17 7h3M18 4l3 3-3 3M18 14l3 3-3 3"/> }
        @case ('queue') { <path d="M4 6h12M4 12h12M4 18h8"/><path d="M17 15l4 3-4 3z" fill="currentColor"/> }
        @case ('plus') { <path d="M12 5v14M5 12h14"/> }
        @case ('more') { <circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/> }
        @case ('down') { <path d="M6 9l6 6 6-6"/> }
        @case ('chevron') { <path d="M9 6l6 6-6 6"/> }
        @case ('back') { <path d="M15 6l-6 6 6 6"/> }
        @case ('repeat') { <path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3"/> }
        @case ('repeat-one') { <path d="M4 11V9a3 3 0 0 1 3-3h12M16 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H5M8 21l-3-3 3-3"/><path d="M11.5 10.5l1.5-1v5"/> }
        @case ('grip') { <circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/> }
        @case ('queue-add') { <path d="M4 6h12M4 12h8M4 18h8M17 13v8M13 17h8"/> }
        @case ('play-next') { <path d="M4 6h9M4 12h9M4 18h6"/><path d="M15 9v9l6-4.5z" fill="currentColor"/> }
        @case ('reroll') { <path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/> }
        @case ('edit') { <path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/> }
        @case ('close') { <path d="M6 6l12 12M18 6L6 18"/> }
        @case ('trash') { <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/> }
        @case ('save') { <path d="M12 4v11M7 10l5 5 5-5M5 20h14"/> }
        @case ('bookmark') { <path d="M6 3h12v18l-6-4-6 4z"/> }
        @case ('cloud') { <path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z"/> }
        @case ('download') { <path d="M12 4v11M7 10l5 5 5-5M5 20h14"/> }
        @case ('phone') { <rect x="7" y="3" width="10" height="18" rx="2"/> }
        @case ('infinite') { <path d="M7 8c-2.2 0-4 1.8-4 4s1.8 4 4 4c4 0 6-8 10-8 2.2 0 4 1.8 4 4s-1.8 4-4 4c-4 0-6-8-10-8z"/> }
      }
    </svg>
  `,
  styles: [`:host { display: inline-flex; line-height: 0; }`],
})
export class IconComponent {
  readonly name = input.required<IconName>();
  readonly size = input(22);
}
