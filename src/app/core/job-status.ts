import { ENDED_PHASES, type InstallView, type JobView } from '@shared/types';

import { bytesText, secondsText } from './format';

/**
 * How one song being made is shown, wherever it is shown: the playing list, and
 * a playlist's last rows while its song is made there (New Songs).
 */
export function jobEnded(job: JobView): boolean {
  return ENDED_PHASES.includes(job.phase);
}

export function jobTitle(job: JobView): string {
  const batch = job.batch > 1 ? ` (${job.index} of ${job.batch})` : '';
  const seed = job.seed === null ? '' : ` · seed ${job.seed}`;
  return `${job.params.instrumental ? 'Instrumental' : 'Song'}${batch}${seed}`;
}

/** The bar's fill, 0..1, or null for an indeterminate bar. */
export function jobShare(job: JobView): number | null {
  const install = job.install;
  if (job.phase === 'installing' && install !== null) {
    return install.bytesTotal ? (install.bytesDone ?? 0) / install.bytesTotal : null;
  }
  if (job.phase === 'running' || job.phase === 'fetching') return job.fraction;
  return null;
}

/** The status line, as the Crucible playground words it; `now` is the clock it is waited against. */
export function jobStatus(job: JobView, now: number): string {
  const waited = secondsText(((job.ended ?? now) - job.since) / 1000);
  switch (job.phase) {
    case 'submitting':
      return job.message ?? 'Sending the job…';
    case 'installing':
      return `${installText(job.install)} (${waited})`;
    case 'queued': {
      const where = job.position === null ? 'in line' : `number ${job.position}${job.of ? ` of ${job.of}` : ''} in line`;
      return `Waiting for the server, ${where} (${waited})${job.message ? ` — ${job.message}` : ''}`;
    }
    case 'running': {
      const said = job.message ? job.message.charAt(0).toUpperCase() + job.message.slice(1) : 'Working';
      const share = job.fraction === null ? '' : `, ${Math.round(job.fraction * 100)}%`;
      return `${said}${share} (${waited})`;
    }
    case 'fetching':
      return job.message ?? 'Fetching the song…';
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Cancelled.';
    case 'removed':
      return 'It left the server\'s queue without running. Generate again to send it again.';
    case 'refused':
      return 'The server refused it:';
    case 'failed':
      return 'It failed:';
  }
}

export function jobCancellable(job: JobView): boolean {
  if (jobEnded(job)) return false;
  if (job.phase === 'installing') return job.install?.ours === true;
  return true;
}

function installText(install: InstallView | null): string {
  if (install === null) return 'Installing';
  let said = install.ours
    ? 'Downloading what YuE2 needs first, once'
    : 'Waiting for another install on the server to finish';
  if (install.step !== null) said += `: step ${install.step.index} of ${install.step.total}, ${install.step.name}`;
  const done = bytesText(install.bytesDone);
  if (done !== null) {
    const total = bytesText(install.bytesTotal);
    said += `, ${done}${total === null ? ' so far' : ` of ${total}`}`;
  }
  return `${said}. The job starts by itself after it`;
}
