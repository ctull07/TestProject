import { listFiles, startDownload, deleteItems, moveItems, copyItems, ApiError } from './api.js';
import { toUrl, fromLocation } from './router.js';
import { UploadQueue } from './UploadQueue.js';
import { confirmDelete, pickFolder } from './dialogs.js';
import { formatBytes, formatDate, count, parentPath, escapeHtml } from './format.js';

const ROW_HEIGHT = 32;          // fixed, so the visible window can be computed from scrollTop alone
const OVERSCAN = 8;             // extra rows rendered above and below the viewport to hide scroll flicker
const SEARCH_DEBOUNCE_MS = 200;
const UPLOAD_LIST_LIMIT = 6;    // rows shown in the upload panel; the rest are summarized
const SUCCESS_LINGER_MS = 4000;

/**
 * The whole browser as one component. It renders into `root`, owns the UI state, and talks to the server
 * through api.js. Because it only needs a root element and a router, it can be mounted anywhere,
 * for example inside a dialog.
 *
 * State is { path, q, sort, dir }. It is the same object that router.js reads from and writes to the URL.
 * Selection and uploads are working state, so they are deliberately not part of the URL.
 */
export class FileBrowser {
    #root;
    #router;
    #state;
    #listing = null;              // last successful response
    #error = null;                // last failed response, or null
    #abort = null;                // cancels the request that is still in flight
    #selection = new Set();       // paths of selected entries
    #viewKey = '';                // folder + search text; the selection is cleared when it changes
    #busy = false;                // true while a delete, move or copy request is running
    #uploads;
    #uploadFrame = 0;
    #searchTimer = 0;
    #scrollFrame = 0;
    #noticeTimer = 0;
    #lingerTimer = 0;
    #el = {};

    constructor(root, router) {
        this.#root = root;
        this.#router = router;
        this.#uploads = new UploadQueue({
            onChange: () => this.#scheduleUploadRender(),
            onSettled: folders => this.#uploadsSettled(folders)
        });
    }

    start() {
        this.#buildShell();
        this.#bindEvents();
        this.#router.onPop(state => this.#setState(state));
        this.#state = this.#router.current;
        this.#router.replace(this.#state);       // rewrites "/" to the canonical "/browse" form
        this.#syncSearchBox();
        this.#load();
    }

    // ---- state and navigation ---------------------------------------------------------------------------

    /** Merges a change into the state, updates the address bar, and reloads. */
    #navigate(patch, { replace = false } = {}) {
        const next = { ...this.#state, ...patch };
        if (toUrl(next) === toUrl(this.#state)) return;
        this.#state = next;
        replace ? this.#router.replace(next) : this.#router.push(next);
        this.#load();
    }

    /** Adopts a state that came from the browser (Back/Forward) and reloads. */
    #setState(state) {
        this.#state = state;
        this.#syncSearchBox();
        this.#load();
    }

    async #load({ keepScroll = false } = {}) {
        this.#abort?.abort();                    // a newer request always wins over an older one
        const request = (this.#abort = new AbortController());
        this.#root.setAttribute('aria-busy', 'true');

        const viewKey = this.#state.path + '\n' + this.#state.q;
        if (viewKey !== this.#viewKey) {
            this.#viewKey = viewKey;
            if (this.#selection.size) {
                this.#selection.clear();
                this.#renderSelection();         // do not leave Download enabled for the old folder while the new one loads
            }
        }

        try {
            this.#listing = await listFiles(this.#state, request.signal);
            this.#error = null;
            this.#dropMissingFromSelection();
        } catch (err) {
            if (err.name === 'AbortError') return;
            this.#listing = null;
            this.#error = err instanceof ApiError ? err : new ApiError(0, 'Could not reach the server');
            this.#selection.clear();
        }
        this.#root.removeAttribute('aria-busy');
        if (!keepScroll) this.#el.viewport.scrollTop = 0;
        this.#render();
    }

    #dropMissingFromSelection() {
        if (this.#selection.size === 0) return;
        const present = new Set(this.#listing.entries.map(e => e.path));
        for (const path of this.#selection) {
            if (!present.has(path)) this.#selection.delete(path);
        }
    }

    // ---- events -----------------------------------------------------------------------------------------

    #bindEvents() {
        // Folder names and breadcrumbs are real links, so "open in new tab" and copy-link work.
        // A plain left click is handled in place; anything else is left to the browser.
        this.#root.addEventListener('click', event => {
            const link = event.target.closest('a[data-nav]');
            if (link) {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                this.#navigate(fromLocation(new URL(link.href)));
                return;
            }
            const action = event.target.closest('button[data-action]')?.dataset.action;
            if (action === 'upload') this.#el.fileInput.click();
            else if (action === 'download') this.#downloadSelection();
            else if (action === 'copy') this.#transferSelection('copy');
            else if (action === 'move') this.#transferSelection('move');
            else if (action === 'delete') this.#deleteSelection();
            else if (action === 'dismiss-uploads') this.#dismissUploads();
        });

        // The Delete key asks to delete the selection, unless the user is typing in the search box.
        this.#root.addEventListener('keydown', event => {
            if (event.key === 'Delete' && event.target !== this.#el.search) this.#deleteSelection();
        });

        this.#el.head.addEventListener('click', event => {
            const button = event.target.closest('button[data-sort]');
            if (button) this.#sortBy(button.dataset.sort);
        });

        this.#el.search.addEventListener('input', () => {
            clearTimeout(this.#searchTimer);
            this.#searchTimer = setTimeout(
                () => this.#navigate({ q: this.#el.search.value.trim() }, { replace: true }),
                SEARCH_DEBOUNCE_MS);
        });

        this.#el.search.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.#el.search.value) {
                this.#el.search.value = '';
                this.#navigate({ q: '' }, { replace: true });
            }
        });

        // Selection
        this.#el.rows.addEventListener('change', event => {
            const box = event.target.closest('input[data-select]');
            if (!box) return;
            box.checked ? this.#selection.add(box.dataset.path) : this.#selection.delete(box.dataset.path);
            this.#renderSelection();
        });
        this.#el.selectAll.addEventListener('change', () => {
            this.#selection.clear();
            if (this.#el.selectAll.checked) {
                for (const entry of this.#listing?.entries ?? []) this.#selection.add(entry.path);
            }
            this.#renderSelection();
        });

        // Upload: from the button, or by dropping files on the list
        this.#el.fileInput.addEventListener('change', () => {
            this.#queueUploads([...this.#el.fileInput.files]);
            this.#el.fileInput.value = '';       // lets the same file be chosen again
        });
        const viewport = this.#el.viewport;
        viewport.addEventListener('dragover', event => {
            if (![...event.dataTransfer.types].includes('Files')) return;
            event.preventDefault();
            viewport.classList.add('dragging');
        });
        viewport.addEventListener('dragleave', event => {
            if (!viewport.contains(event.relatedTarget)) viewport.classList.remove('dragging');
        });
        viewport.addEventListener('drop', event => {
            event.preventDefault();
            viewport.classList.remove('dragging');
            const { files, skippedFolders } = droppedFiles(event.dataTransfer);   // must be read inside the event
            if (skippedFolders) this.#notify('Folders cannot be uploaded. Only the files you dropped were sent.', true);
            this.#queueUploads(files);
        });

        viewport.addEventListener('scroll', () => {
            if (this.#scrollFrame) return;       // at most one repaint per animation frame
            this.#scrollFrame = requestAnimationFrame(() => {
                this.#scrollFrame = 0;
                this.#renderRows();
            });
        }, { passive: true });

        new ResizeObserver(() => this.#renderRows()).observe(viewport);
    }

    #sortBy(field) {
        if (this.#state.sort === field) {
            this.#navigate({ dir: this.#state.dir === 'asc' ? 'desc' : 'asc' }, { replace: true });
        } else {
            // Names read best A to Z; sizes and dates are most useful biggest and newest first.
            this.#navigate({ sort: field, dir: field === 'name' ? 'asc' : 'desc' }, { replace: true });
        }
    }

    #syncSearchBox() {
        if (this.#el.search.value.trim() !== this.#state.q) {
            this.#el.search.value = this.#state.q;
        }
    }

    // ---- transfers --------------------------------------------------------------------------------------

    #downloadSelection() {
        if (this.#selection.size === 0) return;
        startDownload([...this.#selection], message => this.#notify(message, true));
    }

    #selectedEntries() {
        return (this.#listing?.entries ?? []).filter(entry => this.#selection.has(entry.path));
    }

    async #deleteSelection() {
        const entries = this.#selectedEntries();
        if (entries.length === 0 || this.#busy) return;
        if (!await confirmDelete(entries)) return;
        await this.#perform(
            () => deleteItems(entries.map(e => e.path)),
            result => `Deleted ${count(result.succeeded, 'item', 'items')}.`);
    }

    /** Move and copy are the same flow with a different verb and request. */
    async #transferSelection(kind) {
        const entries = this.#selectedEntries();
        if (entries.length === 0 || this.#busy) return;
        const move = kind === 'move';

        const destination = await pickFolder({
            title: `${move ? 'Move' : 'Copy'} ${count(entries.length, 'item', 'items')} to`,
            confirmLabel: move ? 'Move' : 'Copy',
            startPath: this.#state.path,
            blockedPaths: entries.filter(e => e.type === 'folder').map(e => e.path),
            // Outside a search every item is already in the current folder, so moving here would do nothing.
            unavailablePath: move && !this.#state.q ? this.#state.path : null
        });
        if (destination === null) return;

        const send = move ? moveItems : copyItems;
        await this.#perform(
            () => send(entries.map(e => e.path), destination),
            result => `${move ? 'Moved' : 'Copied'} ${count(result.succeeded, 'item', 'items')} to ${destination}.`);
    }

    /**
     * Runs one delete, move or copy request, tells the user what happened, and refreshes the list.
     * The server reports each item separately, so a partly successful batch is shown as both.
     */
    async #perform(request, successMessage) {
        this.#busy = true;
        this.#root.setAttribute('aria-busy', 'true');
        this.#renderToolbar();
        try {
            const result = await request();
            const parts = [];
            if (result.succeeded) parts.push(successMessage(result));
            if (result.skipped) parts.push(`${count(result.skipped, 'item was', 'items were')} already in that folder.`);
            if (!result.succeeded && !result.skipped && !result.failed.length) parts.push('Nothing to do.');
            for (const failure of result.failed.slice(0, 3)) parts.push(`${failure.path}: ${failure.error}.`);
            if (result.failed.length > 3) parts.push(`And ${result.failed.length - 3} more failed.`);
            this.#notify(parts.join(' '), result.failed.length > 0, result.failed.length ? 12000 : 6000);
        } catch (err) {
            this.#notify(err.message, true);
        }
        this.#selection.clear();
        this.#busy = false;
        this.#root.removeAttribute('aria-busy');
        await this.#load({ keepScroll: true });
    }

    #queueUploads(files) {
        if (files.length === 0 || this.#error) return;
        clearTimeout(this.#lingerTimer);
        this.#uploads.add(files, this.#state.path);
    }

    /** The queue emptied. Refresh the list if any file landed in the folder being viewed. */
    #uploadsSettled(folders) {
        if (folders.has(this.#state.path)) this.#load({ keepScroll: true });
        if (this.#uploads.stats.failed === 0) {
            this.#lingerTimer = setTimeout(() => this.#dismissUploads(), SUCCESS_LINGER_MS);
        }
    }

    #dismissUploads() {
        clearTimeout(this.#lingerTimer);
        this.#uploads.clearFinished();
    }

    #notify(message, isError = false, duration = 6000) {
        const notice = this.#el.notice;
        notice.textContent = message;
        notice.classList.toggle('error', isError);
        notice.hidden = false;
        clearTimeout(this.#noticeTimer);
        this.#noticeTimer = setTimeout(() => { notice.hidden = true; }, duration);
    }

    // ---- rendering --------------------------------------------------------------------------------------

    #buildShell() {
        this.#root.innerHTML = `
            <div class="fb">
                <div class="fb-bar">
                    <nav class="crumbs" aria-label="Breadcrumb"></nav>
                    <input class="search" type="search" autocomplete="off" aria-label="Search files and folders"
                           placeholder="Search this folder and everything below">
                    <div class="actions">
                        <button type="button" class="btn" data-action="upload">Upload</button>
                        <button type="button" class="btn" data-action="download" disabled>Download</button>
                        <button type="button" class="btn" data-action="copy" disabled>Copy to...</button>
                        <button type="button" class="btn" data-action="move" disabled>Move to...</button>
                        <button type="button" class="btn danger" data-action="delete" disabled>Delete</button>
                        <input type="file" class="file-input" multiple hidden>
                    </div>
                </div>
                <div class="summary" role="status" aria-live="polite"></div>
                <div class="notice" role="alert" hidden></div>
                <div class="uploads" hidden></div>
                <div class="viewport">
                    <div class="head">
                        <label class="check"><input type="checkbox" class="select-all" aria-label="Select all"></label>
                        <button type="button" data-sort="name">Name<span class="arrow"></span></button>
                        <button type="button" data-sort="size" class="num">Size<span class="arrow"></span></button>
                        <button type="button" data-sort="modified" class="when">Modified<span class="arrow"></span></button>
                    </div>
                    <div class="spacer"><div class="rows"></div></div>
                    <div class="message" hidden></div>
                </div>
            </div>`;
        const q = selector => this.#root.querySelector(selector);
        this.#el = {
            crumbs: q('.crumbs'), search: q('.search'), summary: q('.summary'), notice: q('.notice'),
            uploads: q('.uploads'), viewport: q('.viewport'), head: q('.head'), spacer: q('.spacer'),
            rows: q('.rows'), message: q('.message'), selectAll: q('.select-all'),
            fileInput: q('.file-input'), uploadButton: q('[data-action=upload]'), downloadButton: q('[data-action=download]'),
            needsSelection: [...this.#root.querySelectorAll('[data-action=copy], [data-action=move], [data-action=delete]')]
        };
    }

    #render() {
        this.#renderCrumbs();
        this.#renderSortArrows();
        this.#renderSelection();
        this.#renderMessage();
        const folder = this.#state.path.split('/').filter(Boolean).pop();
        document.title = (folder ? folder + ' - ' : '') + 'File Browser';
    }

    /** Everything that depends on the selection. Cheap enough to run on every checkbox click. */
    #renderSelection() {
        this.#renderSummary();
        this.#renderToolbar();
        this.#renderRows();
    }

    #linkTo(patch) {
        return escapeHtml(toUrl({ ...this.#state, q: '', ...patch }));
    }

    #renderCrumbs() {
        const segments = this.#state.path.split('/').filter(Boolean);
        let path = '';
        const parts = [`<a data-nav href="${this.#linkTo({ path: '/' })}">Home</a>`];
        segments.forEach((segment, i) => {
            path += '/' + segment;
            parts.push(i === segments.length - 1
                ? `<span aria-current="page">${escapeHtml(segment)}</span>`
                : `<a data-nav href="${this.#linkTo({ path })}">${escapeHtml(segment)}</a>`);
        });
        this.#el.crumbs.innerHTML = parts.join('<span class="sep">/</span>');
    }

    #renderSortArrows() {
        for (const button of this.#el.head.querySelectorAll('button[data-sort]')) {
            const active = button.dataset.sort === this.#state.sort;
            button.classList.toggle('active', active);
            button.querySelector('.arrow').textContent = active ? (this.#state.dir === 'asc' ? ' ↑' : ' ↓') : '';
        }
    }

    /** The counts-and-sizes line for the current view, plus the selection when there is one. */
    #renderSummary() {
        const summary = this.#el.summary;
        if (!this.#listing) {
            summary.textContent = this.#error ? 'Could not load this view' : 'Loading...';
            return;
        }
        const { totals, query, path, truncated, entries } = this.#listing;
        const parts = [];
        if (query) {
            const matches = count(entries.length, 'match', 'matches') + (truncated ? '+' : '');
            parts.push(`${matches} for “${escapeHtml(query)}” under <code>${escapeHtml(path)}</code>`);
        }
        parts.push(count(totals.folders, 'folder', 'folders'));
        parts.push(count(totals.files, 'file', 'files'));
        parts.push(`${formatBytes(totals.bytes)} in files`);
        if (truncated) parts.push('showing the first results only, so narrow the search');
        if (this.#selection.size) {
            let bytes = 0;
            for (const entry of entries) {
                if (this.#selection.has(entry.path)) bytes += entry.size ?? 0;
            }
            parts.push(`<b class="selected-info">${this.#selection.size.toLocaleString()} selected (${formatBytes(bytes)} in files)</b>`);
        }
        summary.innerHTML = parts.map(p => `<span>${p}</span>`).join('');
    }

    #renderToolbar() {
        const total = this.#listing?.entries.length ?? 0;
        const selected = this.#selection.size;
        this.#el.uploadButton.disabled = !this.#listing || this.#busy;
        this.#el.downloadButton.disabled = selected === 0;
        for (const button of this.#el.needsSelection) button.disabled = selected === 0 || this.#busy;
        this.#el.downloadButton.textContent = selected ? `Download (${selected.toLocaleString()})` : 'Download';
        this.#el.selectAll.checked = total > 0 && selected === total;
        this.#el.selectAll.indeterminate = selected > 0 && selected < total;
        this.#el.selectAll.disabled = total === 0;
    }

    #renderMessage() {
        const message = this.#el.message;
        let html = '';
        if (this.#error) {
            html = `<strong>${this.#error.status ? this.#error.status + ': ' : ''}${escapeHtml(this.#error.message)}</strong>
                    <a data-nav href="${this.#linkTo({ path: '/' })}">Go to Home</a>`;
        } else if (this.#listing && this.#listing.entries.length === 0) {
            html = this.#state.q
                ? `<strong>No matches for “${escapeHtml(this.#state.q)}”</strong>
                   <span>Searched ${escapeHtml(this.#listing.path)} and everything below it.</span>`
                : '<strong>This folder is empty</strong><span>Upload files, or drop them here.</span>';
        }
        message.hidden = !html;
        message.innerHTML = html;
    }

    /**
     * Windowed rendering: only the rows near the viewport exist in the DOM. A folder with 50,000 files
     * costs the same to scroll as one with 50. The spacer gives the scrollbar its full height, and the
     * rows container is shifted down to where the first rendered row belongs.
     */
    #renderRows() {
        const entries = this.#listing?.entries ?? [];
        const { viewport, spacer, rows } = this.#el;
        spacer.style.height = entries.length * ROW_HEIGHT + 'px';

        const first = Math.max(0, Math.floor(viewport.scrollTop / ROW_HEIGHT) - OVERSCAN);
        const last = Math.min(entries.length, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_HEIGHT) + OVERSCAN);

        const searching = Boolean(this.#listing?.query);
        let html = '';
        for (let i = first; i < last; i++) {
            html += this.#rowHtml(entries[i], searching);
        }
        rows.style.transform = `translateY(${first * ROW_HEIGHT}px)`;
        rows.innerHTML = html;
    }

    #rowHtml(entry, searching) {
        const isFolder = entry.type === 'folder';
        const selected = this.#selection.has(entry.path);
        const name = isFolder
            ? `<a data-nav class="name folder" href="${this.#linkTo({ path: entry.path })}">${escapeHtml(entry.name)}</a>`
            : `<span class="name">${escapeHtml(entry.name)}</span>`;
        // In search results the same name can appear in many folders, so show where each one lives.
        const where = searching ? `<span class="where">${escapeHtml(parentPath(entry.path))}</span>` : '';
        return `<div class="row${selected ? ' selected' : ''}">
                    <label class="check"><input type="checkbox" data-select data-path="${escapeHtml(entry.path)}"
                        aria-label="Select ${escapeHtml(entry.name)}"${selected ? ' checked' : ''}></label>
                    <div class="cell-name">${name}${where}</div>
                    <div class="num">${isFolder ? '' : formatBytes(entry.size)}</div>
                    <div class="when">${formatDate(entry.modified)}</div>
                </div>`;
    }

    // ---- upload panel -----------------------------------------------------------------------------------

    /** Progress events arrive far faster than a screen refreshes, so repaint at most once per frame. */
    #scheduleUploadRender() {
        if (this.#uploadFrame) return;
        this.#uploadFrame = requestAnimationFrame(() => {
            this.#uploadFrame = 0;
            this.#renderUploads();
        });
    }

    #renderUploads() {
        const panel = this.#el.uploads;
        const stats = this.#uploads.stats;
        if (stats.total === 0) {
            panel.hidden = true;
            return;
        }
        const busy = stats.active > 0;
        const title = busy
            ? `Uploading ${count(stats.total, 'file', 'files')} (${stats.finished} done)`
            : stats.failed
                ? `Uploaded ${stats.done} of ${count(stats.total, 'file', 'files')}, ${stats.failed} failed`
                : `Uploaded ${count(stats.done, 'file', 'files')}`;

        // Show only what needs attention: files in flight, failures, and files that had to be renamed.
        const notable = this.#uploads.items.filter(item =>
            item.status === 'uploading' || item.status === 'error' || (item.status === 'done' && item.savedAs !== item.file.name));
        const lines = notable.slice(0, UPLOAD_LIST_LIMIT).map(item => {
            const note = item.status === 'uploading' ? `${Math.floor((item.loaded / Math.max(item.file.size, 1)) * 100)}%`
                : item.status === 'error' ? escapeHtml(item.error)
                : `saved as ${escapeHtml(item.savedAs)}`;
            return `<li class="${item.status}"><span class="u-name">${escapeHtml(item.file.name)}</span><span class="u-note">${note}</span></li>`;
        });
        if (notable.length > UPLOAD_LIST_LIMIT) lines.push(`<li class="more">and ${notable.length - UPLOAD_LIST_LIMIT} more</li>`);

        panel.hidden = false;
        panel.innerHTML = `
            <div class="uploads-head">
                <strong>${title}</strong>
                <progress max="${Math.max(stats.bytesTotal, 1)}" value="${stats.bytesLoaded}"></progress>
                ${busy ? '' : '<button type="button" class="btn small" data-action="dismiss-uploads">Dismiss</button>'}
            </div>
            ${lines.length ? `<ul>${lines.join('')}</ul>` : ''}`;
    }
}

/**
 * Splits a drop into files and folders. Browsers hand a dropped folder over as a bogus zero-size "file",
 * so each item is asked what it really is. DataTransfer is only readable during the drop event itself.
 */
function droppedFiles(dataTransfer) {
    const files = [];
    let skippedFolders = 0;
    for (const item of dataTransfer.items) {
        if (item.kind !== 'file') continue;
        if (item.webkitGetAsEntry?.()?.isDirectory) {
            skippedFolders++;
            continue;
        }
        const file = item.getAsFile();
        if (file) files.push(file);
    }
    return { files, skippedFolders };
}
