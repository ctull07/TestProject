import { folderSize } from './api.js';

const CONCURRENCY = 4;          // measuring a folder walks the disk, so only a few run at once
const MAX_AGE_MS = 60_000;      // matches the server cache; older answers are fetched again

/**
 * Loads folder sizes in the background and remembers them.
 *
 * `load(visible, background)` says what is wanted: the visible paths go first, then the background ones.
 * Anything in flight that is no longer wanted is cancelled, which also stops the server's walk.
 * It is cheap to call repeatedly, so the component simply calls it after every render.
 *
 * `get(path)` returns { bytes, files, folders }, { failed: true }, or undefined while unknown.
 */
export class FolderSizes {
    #onChange;
    #results = new Map();       // path -> { bytes, files, folders, at } | { failed: true, at }
    #active = new Map();        // path -> AbortController
    #queue = [];
    #epoch = 0;                 // bumped by clear(), so a late answer from before the change is ignored

    constructor({ onChange }) {
        this.#onChange = onChange;
    }

    get(path) {
        const result = this.#results.get(path);
        if (result && Date.now() - result.at > MAX_AGE_MS) {
            this.#results.delete(path);
            return undefined;
        }
        return result;
    }

    load(visible, background = []) {
        const wanted = new Set([...visible, ...background]);
        for (const [path, controller] of this.#active) {
            if (!wanted.has(path)) {
                controller.abort();
                this.#active.delete(path);
            }
        }
        this.#queue = [...wanted].filter(path => !this.get(path) && !this.#active.has(path));
        this.#pump();
    }

    /** Stops everything in flight and queued, but keeps what has been measured. Used when the view changes. */
    cancel() {
        this.#queue = [];
        for (const controller of this.#active.values()) controller.abort();
        this.#active.clear();
    }

    /** Forgets every size too. Used after an upload, delete, move or copy, which change them. */
    clear() {
        this.cancel();
        this.#results.clear();
        this.#epoch++;
    }

    #pump() {
        while (this.#active.size < CONCURRENCY && this.#queue.length) {
            this.#measure(this.#queue.shift());
        }
    }

    async #measure(path) {
        const controller = new AbortController();
        const epoch = this.#epoch;
        this.#active.set(path, controller);
        try {
            const { bytes, files, folders } = await folderSize(path, controller.signal);
            if (epoch !== this.#epoch) return;
            this.#results.set(path, { bytes, files, folders, at: Date.now() });
        } catch (err) {
            if (err.name === 'AbortError' || epoch !== this.#epoch) return;
            this.#results.set(path, { failed: true, at: Date.now() });   // not retried until the next change
        }
        if (this.#active.get(path) === controller) this.#active.delete(path);
        this.#onChange();
        this.#pump();
    }
}
