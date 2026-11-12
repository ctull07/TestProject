import { uploadFile } from './api.js';

const CONCURRENCY = 3;     // enough to keep the connection busy without starving the server of memory

/**
 * Sends files to the server a few at a time and tracks each one. It knows nothing about the DOM:
 * the owner is told through callbacks when something changed, and renders however it likes.
 *
 * Every item remembers the folder it was queued for, so navigating elsewhere mid-upload
 * cannot send a file to the wrong place.
 */
export class UploadQueue {
    #items = [];
    #running = 0;
    #changedFolders = new Set();
    #onChange;
    #onSettled;

    /**
     * @param onChange   called whenever any item's progress or status changes
     * @param onSettled  called when the queue empties, with the folders that received files
     */
    constructor({ onChange, onSettled }) {
        this.#onChange = onChange;
        this.#onSettled = onSettled;
    }

    get items() {
        return this.#items;
    }

    get stats() {
        let done = 0, failed = 0, active = 0, bytesTotal = 0, bytesLoaded = 0;
        for (const item of this.#items) {
            bytesTotal += item.file.size;
            bytesLoaded += item.loaded;
            if (item.status === 'done') done++;
            else if (item.status === 'error') failed++;
            else active++;
        }
        return { total: this.#items.length, done, failed, active, finished: done + failed, bytesTotal, bytesLoaded };
    }

    add(files, folderPath) {
        for (const file of files) {
            this.#items.push({ file, folderPath, status: 'queued', loaded: 0, savedAs: null, error: null });
        }
        this.#onChange();
        this.#pump();
    }

    /** Forgets finished items. Anything still queued or uploading is kept. */
    clearFinished() {
        this.#items = this.#items.filter(item => item.status === 'queued' || item.status === 'uploading');
        this.#onChange();
    }

    #pump() {
        while (this.#running < CONCURRENCY) {
            const next = this.#items.find(item => item.status === 'queued');
            if (!next) return;
            this.#run(next);
        }
    }

    async #run(item) {
        item.status = 'uploading';
        this.#running++;
        try {
            const result = await uploadFile(item.folderPath, item.file, loaded => {
                item.loaded = loaded;
                this.#onChange();
            });
            item.status = 'done';
            item.loaded = item.file.size;
            item.savedAs = result.name;
            this.#changedFolders.add(item.folderPath);
        } catch (err) {
            item.status = 'error';
            item.error = err.message;
        }
        this.#running--;
        this.#onChange();

        this.#pump();
        if (this.#running === 0 && !this.#items.some(i => i.status === 'queued')) {
            const folders = this.#changedFolders;
            this.#changedFolders = new Set();
            this.#onSettled(folders);
        }
    }
}
