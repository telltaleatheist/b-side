import { Injectable, signal } from '@angular/core';

export interface Question {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
  readonly danger: boolean;
}

interface Asked extends Question {
  readonly answer: (yes: boolean) => void;
}

/** One question at a time, drawn by ConfirmDialogComponent in the shell. */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly asked = signal<Asked | null>(null);

  ask(question: Question): Promise<boolean> {
    // A question still open is answered "no" before the next is drawn.
    this.asked()?.answer(false);
    return new Promise((resolve) => {
      this.asked.set({
        ...question,
        answer: (yes) => {
          this.asked.set(null);
          resolve(yes);
        },
      });
    });
  }
}
