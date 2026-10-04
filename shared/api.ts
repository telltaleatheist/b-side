/**
 * api — `window.bside`, the whole surface the renderer may touch.
 *
 * Implemented by electron/preload.ts over IPC; the renderer is typed against
 * this same declaration. Every call that can be refused answers an `Outcome`,
 * so the server's named refusal reaches the screen intact.
 */
import type {
  AppSettingsView,
  GenerateRequest,
  JobView,
  LibraryView,
  Outcome,
  Preset,
  ServerInput,
  ServerProbe,
  ServerView,
  Song,
  SongForm,
  SongPage,
} from './types';

export interface BSideApi {
  servers: {
    list(): Promise<ServerView[]>;
    /** Add from a `crucible://<name>@<host>:<port>/#<token>` line. */
    addPairing(line: string): Promise<Outcome<ServerView[]>>;
    add(input: ServerInput): Promise<Outcome<ServerView[]>>;
    /** Edit the server stored as `name`; `input.token: null` keeps its token. */
    update(name: string, input: ServerInput): Promise<Outcome<ServerView[]>>;
    remove(name: string): Promise<Outcome<ServerView[]>>;
    setActive(name: string): Promise<Outcome<ServerView[]>>;
    /** `GET /v1/info` on the named server. */
    test(name: string): Promise<Outcome<ServerProbe>>;
    onChanged(listener: (servers: ServerView[]) => void): () => void;
  };

  song: {
    /** The active server's `yue2-3b` page: tag suggestions, conflicts, cfg limits, standing. */
    page(): Promise<Outcome<SongPage>>;
  };

  presets: {
    list(): Promise<Outcome<Preset[]>>;
    save(name: string, form: SongForm): Promise<Outcome<Preset[]>>;
    remove(name: string): Promise<Outcome<Preset[]>>;
  };

  jobs: {
    list(): Promise<JobView[]>;
    generate(request: GenerateRequest): Promise<Outcome<JobView[]>>;
    cancel(key: string): Promise<Outcome<null>>;
    /** Forget an ended job that did not become a song (failed, cancelled, removed, refused). */
    dismiss(key: string): Promise<void>;
    onChanged(listener: (job: JobView) => void): () => void;
  };

  library: {
    list(): Promise<LibraryView>;
    rename(id: string, title: string): Promise<Outcome<Song>>;
    remove(id: string): Promise<Outcome<null>>;
    /** Ask where to save a copy, then copy the song there. Null when the person cancelled. */
    saveCopy(id: string): Promise<Outcome<string | null>>;
    reveal(id: string): Promise<void>;
    /** A song a job just finished: `fromJob` is what lets the player pick it up. */
    onAdded(listener: (song: Song) => void): () => void;
    onChanged(listener: (library: LibraryView) => void): () => void;
  };

  settings: {
    get(): Promise<AppSettingsView>;
    chooseLibraryDir(): Promise<Outcome<AppSettingsView | null>>;
    resetLibraryDir(): Promise<Outcome<AppSettingsView>>;
  };

  clipboard: {
    write(text: string): Promise<void>;
  };
}
