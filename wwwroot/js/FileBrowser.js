import { listFiles, ApiError } from './api.js';
import { toUrl, fromLocation } from './router.js';
import { formatBytes, formatDate, count, parentPath, escapeHtml } from './format.js';

const ROW_HEIGHT = 32;          // fixed, so the visible window can be computed from scrollTop alone
const OVERSCAN = 8;             // extra rows rendered above and below the viewport to hide scroll flicker
const SEARCH_DEBOUNCE_MS = 200;

/**
 * The whole browser as one component. It renders into `root`, owns the UI state, and talks to the server
 * through api.js. Because it only needs a root element and a router, it can be mounted anywhere,
 * for example inside a dialog.
 *
 * State is { path, q, sort, dir }. It is the same object that router.js reads from and writes to the URL.
 */
export class FileBrowser {
    #root;
    #router;
    #state;
    #listing = null;      // last successful response
    #error = null;        // last failed response, or null
    #abort = null;        // cancels the request that is still in flight
    #searchTimer = 0;
    #scrollFrame = 0;
    #el = {};

    constructor(root, router) {
        this.#root = root;
        this.#router = router;
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

    async #load() {
        this.#abort?.abort();                    // a newer request always wins over an older one
        const request = (this.#abort = new AbortController());
        this.#root.setAttribute('aria-busy', 'true');
        try {
            this.#listing = await listFiles(this.#state, request.signal);
            this.#error = null;
        } catch (err) {
            if (err.name === 'AbortError') return;
            this.#listing = null;
            this.#error = err instanceof ApiError ? err : new ApiError(0, 'Could not reach the server');
        }
        this.#root.removeAttribute('aria-busy');
        this.#el.viewport.scrollTop = 0;
        this.#render();
    }

    // ---- events -----------------------------------------------------------------------------------------

    #bindEvents() {
        // Folder names and breadcrumbs are real links, so "open in new tab" and copy-link work.
        // A plain left click is handled in place; anything else is left to the browser.
        this.#root.addEventListener('click', event => {
            const link = event.target.closest('a[data-nav]');
            if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            this.#navigate(fromLocation(new URL(link.href)));
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

        this.#el.viewport.addEventListener('scroll', () => {
            if (this.#scrollFrame) return;       // at most one repaint per animation frame
            this.#scrollFrame = requestAnimationFrame(() => {
                this.#scrollFrame = 0;
                this.#renderRows();
            });
        }, { passive: true });

        new ResizeObserver(() => this.#renderRows()).observe(this.#el.viewport);
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

    // ---- rendering --------------------------------------------------------------------------------------

    #buildShell() {
        this.#root.innerHTML = `
            <div class="fb">
                <div class="fb-bar">
                    <nav class="crumbs" aria-label="Breadcrumb"></nav>
                    <input class="search" type="search" autocomplete="off" aria-label="Search files and folders"
                           placeholder="Search this folder and everything below">
                </div>
                <div class="summary" role="status" aria-live="polite"></div>
                <div class="viewport">
                    <div class="head">
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
            crumbs: q('.crumbs'), search: q('.search'), summary: q('.summary'), viewport: q('.viewport'),
            head: q('.head'), spacer: q('.spacer'), rows: q('.rows'), message: q('.message')
        };
    }

    #render() {
        this.#renderCrumbs();
        this.#renderSortArrows();
        this.#renderSummary();
        this.#renderMessage();
        this.#renderRows();
        const folder = this.#state.path.split('/').filter(Boolean).pop();
        document.title = (folder ? folder + ' - ' : '') + 'File Browser';
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

    /** The counts-and-sizes line required for the current view. */
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
        summary.innerHTML = parts.map(p => `<span>${p}</span>`).join('');
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
                : '<strong>This folder is empty</strong>';
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
        const name = isFolder
            ? `<a data-nav class="name folder" href="${this.#linkTo({ path: entry.path })}">${escapeHtml(entry.name)}</a>`
            : `<span class="name">${escapeHtml(entry.name)}</span>`;
        // In search results the same name can appear in many folders, so show where each one lives.
        const where = searching ? `<span class="where">${escapeHtml(parentPath(entry.path))}</span>` : '';
        return `<div class="row">
                    <div class="cell-name">${name}${where}</div>
                    <div class="num">${isFolder ? '' : formatBytes(entry.size)}</div>
                    <div class="when">${formatDate(entry.modified)}</div>
                </div>`;
    }
}
