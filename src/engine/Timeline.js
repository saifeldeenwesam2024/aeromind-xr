/**
 * @file Timeline.js
 * @description The story director's clock.
 *
 * The experience is a film that happens to be interactive: it plays itself, and
 * the viewer is free to look wherever they like while it does. That demands a
 * clock with three properties:
 *
 *   • **Chapters** with enter/update/exit hooks, so each scene owns its state.
 *   • **Cues** — one-shot events fired when the play-head crosses them, used
 *     for audio and for irreversible state changes.
 *   • **Scrubbing** — seeking backwards must un-fire cues and re-enter the
 *     correct chapter, so a presenter can jump straight to any moment when a
 *     judge asks "show me the scan again".
 *
 * Everything downstream reads time from here. Nothing animates off wall-clock
 * time directly, which is what keeps the two eyes, the audio and the panels
 * frame-accurate with each other.
 */

/**
 * @typedef {object} Chapter
 * @property {string} id Stable identifier.
 * @property {string} title Human-readable label shown in the scrubber.
 * @property {number} start Start time in seconds.
 * @property {number} end End time in seconds.
 * @property {function(object): void} [onEnter] Called when the chapter begins.
 * @property {function(object): void} [onExit] Called when the chapter ends.
 * @property {function(number, number, object): void} [onUpdate] Called every
 *   frame with (localTime, normalisedProgress, context).
 */

/**
 * @typedef {object} Cue
 * @property {number} time Trigger time in seconds.
 * @property {function(object): void} action Callback.
 * @property {string} [id] Optional label, useful when debugging.
 */

/**
 * Chapter-based playback clock with scrubbing support.
 * @class
 */
export class Timeline {
  /**
   * @param {object} [options] Configuration.
   * @param {number} [options.duration] Total length in seconds.
   * @param {boolean} [options.loop] Restart automatically when finished.
   * @param {*} [options.context] Value passed to every hook and cue.
   */
  constructor(options = {}) {
    const { duration = 120, loop = true, context = null } = options;

    /** @type {number} Total length in seconds. */
    this.duration = duration;
    /** @type {boolean} */
    this.loop = loop;
    /** @type {*} Shared context handed to hooks. */
    this.context = context;

    /** @type {number} Current play-head position in seconds. */
    this.time = 0;
    /** @type {boolean} */
    this.playing = false;
    /** @type {number} Playback rate multiplier. */
    this.rate = 1;

    /** @type {Chapter[]} Ordered chapters. */
    this.chapters = [];
    /** @type {Cue[]} Cues, kept sorted by time. */
    this.cues = [];
    /** @type {Set<Cue>} Cues already fired at the current play-head. */
    this._fired = new Set();

    /** @type {number} Index of the active chapter, or -1. */
    this.chapterIndex = -1;
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /* -------------------------------------------------------------- authoring */

  /**
   * Registers a chapter. Chapters are kept sorted by start time.
   * @param {Chapter} chapter Chapter definition.
   * @returns {Timeline} This timeline, for chaining.
   */
  addChapter(chapter) {
    this.chapters.push(chapter);
    this.chapters.sort((a, b) => a.start - b.start);
    return this;
  }

  /**
   * Registers several chapters at once.
   * @param {Chapter[]} chapters Chapter definitions.
   * @returns {Timeline} This timeline, for chaining.
   */
  addChapters(chapters) {
    for (const c of chapters) this.addChapter(c);
    return this;
  }

  /**
   * Registers a one-shot cue.
   * @param {number} time Trigger time in seconds.
   * @param {function(object): void} action Callback.
   * @param {string} [id] Optional label.
   * @returns {Timeline} This timeline, for chaining.
   */
  addCue(time, action, id = '') {
    this.cues.push({ time, action, id });
    this.cues.sort((a, b) => a.time - b.time);
    return this;
  }

  /**
   * Registers many cues at once.
   * @param {Array<[number, function(object): void, string?]>} entries Cue tuples.
   * @returns {Timeline} This timeline, for chaining.
   */
  addCues(entries) {
    for (const [time, action, id] of entries) this.addCue(time, action, id);
    return this;
  }

  /* -------------------------------------------------------------- transport */

  /** Starts or resumes playback. */
  play() {
    if (this.playing) return;
    this.playing = true;
    this.#emit('play', { time: this.time });
  }

  /** Pauses playback, leaving the play-head where it is. */
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.#emit('pause', { time: this.time });
  }

  /**
   * Toggles playback.
   * @returns {boolean} Whether the timeline is now playing.
   */
  toggle() {
    this.playing ? this.pause() : this.play();
    return this.playing;
  }

  /**
   * Moves the play-head.
   *
   * Seeking backwards clears the fired-cue set for everything after the new
   * position, so cues will fire again on the way forward. Chapter transitions
   * are replayed so the scene state matches the new time exactly.
   *
   * @param {number} seconds Absolute time to seek to.
   * @param {boolean} [silent] Skip firing cues that were skipped over.
   */
  seek(seconds, silent = true) {
    const target = Math.max(0, Math.min(this.duration, seconds));
    const backwards = target < this.time;

    this.time = target;

    // Rebuild the fired set to match the new play-head.
    this._fired.clear();
    for (const cue of this.cues) {
      if (cue.time <= target) {
        this._fired.add(cue);
        // Silent seeks skip the audio and state cues that were jumped over,
        // which is what a presenter wants when scrubbing.
        if (!silent && backwards === false) cue.action(this.context);
      }
    }

    this.#resolveChapter(true);
    this.#emit('seek', { time: this.time });
  }

  /** Jumps to the start of the next chapter, or to the end. */
  nextChapter() {
    const next = this.chapters[this.chapterIndex + 1];
    this.seek(next ? next.start + 0.001 : this.duration);
  }

  /**
   * Jumps to the start of the current chapter, or the previous one if the
   * play-head is already close to the current chapter's start — the same
   * behaviour as a music player's "back" button.
   */
  previousChapter() {
    const current = this.chapters[this.chapterIndex];
    if (!current) { this.seek(0); return; }
    if (this.time - current.start > 2.5) { this.seek(current.start + 0.001); return; }
    const previous = this.chapters[this.chapterIndex - 1];
    this.seek(previous ? previous.start + 0.001 : 0);
  }

  /** Restarts from the beginning and plays. */
  restart() {
    this.seek(0);
    this.play();
  }

  /* ----------------------------------------------------------------- update */

  /**
   * Advances the clock and dispatches chapter and cue callbacks.
   * @param {number} dt Delta time in seconds.
   */
  update(dt) {
    if (this.playing) {
      const previous = this.time;
      this.time += dt * this.rate;

      if (this.time >= this.duration) {
        if (this.loop) {
          this.#fireCuesBetween(previous, this.duration);
          this.#exitChapter();
          this.time = this.time - this.duration;
          this._fired.clear();
          this.#emit('loop', {});
          this.#fireCuesBetween(0, this.time);
        } else {
          this.time = this.duration;
          this.playing = false;
          this.#fireCuesBetween(previous, this.duration);
          this.#emit('complete', {});
        }
      } else {
        this.#fireCuesBetween(previous, this.time);
      }
    }

    this.#resolveChapter(false);

    const chapter = this.chapters[this.chapterIndex];
    if (chapter?.onUpdate) {
      const local = this.time - chapter.start;
      const span = chapter.end - chapter.start || 1;
      chapter.onUpdate(local, Math.max(0, Math.min(1, local / span)), this.context);
    }
  }

  /**
   * Fires every cue whose time falls in the half-open interval (from, to].
   * @param {number} from Previous play-head position.
   * @param {number} to Current play-head position.
   * @private
   */
  #fireCuesBetween(from, to) {
    for (const cue of this.cues) {
      if (cue.time > to) break;
      if (cue.time > from && !this._fired.has(cue)) {
        this._fired.add(cue);
        cue.action(this.context);
      }
    }
  }

  /**
   * Selects the chapter containing the play-head, running exit and enter hooks
   * when the selection changes.
   * @param {boolean} force Re-enter even if the index is unchanged.
   * @private
   */
  #resolveChapter(force) {
    let index = -1;
    for (let i = 0; i < this.chapters.length; i++) {
      const c = this.chapters[i];
      if (this.time >= c.start && this.time < c.end) { index = i; break; }
    }
    // Past the final chapter's end, stay on the final chapter.
    if (index === -1 && this.chapters.length && this.time >= this.chapters.at(-1).end) {
      index = this.chapters.length - 1;
    }

    if (index === this.chapterIndex && !force) return;

    if (index !== this.chapterIndex) this.#exitChapter();

    this.chapterIndex = index;
    const chapter = this.chapters[index];
    if (chapter) {
      chapter.onEnter?.(this.context);
      this.#emit('chapter', { index, chapter });
    }
  }

  /**
   * Runs the current chapter's exit hook.
   * @private
   */
  #exitChapter() {
    const chapter = this.chapters[this.chapterIndex];
    chapter?.onExit?.(this.context);
  }

  /* ---------------------------------------------------------------- queries */

  /** @returns {number} Normalised play-head position, 0–1. */
  get progress() {
    return this.duration > 0 ? this.time / this.duration : 0;
  }

  /** @returns {?Chapter} The active chapter, if any. */
  get chapter() {
    return this.chapters[this.chapterIndex] ?? null;
  }

  /** @returns {number} Progress within the active chapter, 0–1. */
  get chapterProgress() {
    const c = this.chapter;
    if (!c) return 0;
    const span = c.end - c.start || 1;
    return Math.max(0, Math.min(1, (this.time - c.start) / span));
  }

  /**
   * A formatted label for the active chapter, e.g. `03 — AI Inspection`.
   * @returns {string}
   */
  get chapterLabel() {
    const c = this.chapter;
    if (!c) return '';
    return `${String(this.chapterIndex + 1).padStart(2, '0')} — ${c.title}`;
  }

  /* ----------------------------------------------------------------- events */

  /**
   * Subscribes to a timeline event: `play`, `pause`, `seek`, `chapter`,
   * `loop` or `complete`.
   * @param {string} type Event name.
   * @param {Function} handler Callback.
   * @returns {function(): void} Unsubscribe function.
   */
  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
    return () => this._listeners.get(type)?.delete(handler);
  }

  /**
   * @param {string} type Event name.
   * @param {*} payload Event payload.
   * @private
   */
  #emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const handler of set) handler(payload);
  }

  /** Clears every listener. */
  dispose() {
    this._listeners.clear();
    this._fired.clear();
  }
}
