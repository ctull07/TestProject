import { listFiles } from './api.js';
import { count, formatBytes, escapeHtml } from './format.js';

// Both dialogs use the native <dialog> element. showModal() gives focus trapping, the Escape key and a
// backdrop for free, and keeps working when the whole browser is later placed inside another dialog.

function openDialog(html) {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.innerHTML = html;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
    return dialog;
}

/**
 * Asks before anything is deleted. Resolves true only if the user clicks Delete.
 * Cancel is the default focus, so an accidental Enter keeps the files.
 */
export function confirmDelete(entries) {
    const folders = entries.filter(e => e.type === 'folder').length;
    const files = entries.length - folders;
    const bytes = entries.reduce((sum, e) => sum + (e.size ?? 0), 0);

    const parts = [];
    if (folders) parts.push(`${count(folders, 'folder', 'folders')} and everything inside`);
    if (files) parts.push(`${count(files, 'file', 'files')} (${formatBytes(bytes)})`);

    const shown = entries.slice(0, 5).map(e => `<li>${escapeHtml(e.name)}</li>`);
    if (entries.length > 5) shown.push(`<li class="more">and ${entries.length - 5} more</li>`);

    const dialog = openDialog(`
        <form method="dialog">
            <h2>Delete ${count(entries.length, 'item', 'items')}?</h2>
            <p>${parts.join(' and ')} will be permanently deleted from the server. This cannot be undone.</p>
            <ul class="modal-list">${shown.join('')}</ul>
            <div class="modal-actions">
                <button type="submit" value="cancel" class="btn" autofocus>Cancel</button>
                <button type="submit" value="delete" class="btn danger">Delete</button>
            </div>
        </form>`);
    return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'));
    });
}

/**
 * A small folder browser for choosing a destination. It reuses the same listing API as the main view
 * and shows folders only. Resolves with the chosen folder path, or null if cancelled.
 *
 * @param blockedPaths    folders that cannot be entered (the ones being moved or copied)
 * @param unavailablePath a folder where confirming makes no sense, such as the one the items are already in
 */
export function pickFolder({ title, confirmLabel, startPath, blockedPaths = [], unavailablePath = null }) {
    const blocked = new Set(blockedPaths);
    let current = startPath;
    let folders = [];
    let error = null;
    let loading = true;
    let latest = 0;

    const dialog = openDialog(`
        <form method="dialog" class="picker">
            <h2>${escapeHtml(title)}</h2>
            <nav class="crumbs" aria-label="Destination folder"></nav>
            <ul class="picker-list" aria-live="polite"></ul>
            <p class="picker-hint"></p>
            <div class="modal-actions">
                <button type="submit" value="cancel" class="btn" autofocus>Cancel</button>
                <button type="submit" value="ok" class="btn primary" disabled></button>
            </div>
        </form>`);
    const crumbs = dialog.querySelector('.crumbs');
    const list = dialog.querySelector('.picker-list');
    const hint = dialog.querySelector('.picker-hint');
    const confirm = dialog.querySelector('button[value=ok]');

    function render() {
        const segments = current.split('/').filter(Boolean);
        let path = '';
        crumbs.innerHTML = [`<button type="button" class="link" data-path="/">Home</button>`]
            .concat(segments.map(segment => {
                path += '/' + segment;
                return `<button type="button" class="link" data-path="${escapeHtml(path)}">${escapeHtml(segment)}</button>`;
            }))
            .join('<span class="sep">/</span>');

        list.innerHTML = folders.map(folder => blocked.has(folder.path)
            ? `<li><button type="button" disabled>${escapeHtml(folder.name)} <small>(selected)</small></button></li>`
            : `<li><button type="button" data-path="${escapeHtml(folder.path)}">${escapeHtml(folder.name)}</button></li>`).join('');

        const unavailable = current === unavailablePath;
        hint.textContent = error ? error
            : loading ? 'Loading...'
            : unavailable ? 'The selected items are already in this folder.'
            : folders.length === 0 ? 'This folder has no subfolders.' : '';
        hint.classList.toggle('error', Boolean(error));
        confirm.textContent = `${confirmLabel} here`;
        confirm.disabled = loading || Boolean(error) || unavailable;
    }

    async function show(path) {
        const mine = ++latest;              // a slower, older response must not overwrite a newer one
        loading = true;
        error = null;
        render();
        try {
            const listing = await listFiles({ path, q: '', sort: 'name', dir: 'asc' });
            if (mine !== latest) return;
            current = listing.path;
            folders = listing.entries.filter(entry => entry.type === 'folder');
        } catch (err) {
            if (mine !== latest) return;
            current = path;
            folders = [];
            error = err.message;
        }
        loading = false;
        render();
    }

    dialog.addEventListener('click', event => {
        const target = event.target.closest('button[data-path]');
        if (target) show(target.dataset.path);
    });

    show(startPath);
    return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? current : null));
    });
}
