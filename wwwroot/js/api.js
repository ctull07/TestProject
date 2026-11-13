// Thin client for the server's JSON API. Nothing in here renders UI.

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** The server answers failures with RFC 7807 problem details, where "title" holds the message. */
function errorMessage(status, bodyText, fallback) {
    try {
        const problem = JSON.parse(bodyText);
        if (problem?.title) return problem.title;
    } catch { /* not JSON */ }
    if (status === 413) return 'The file is larger than the server allows';
    return fallback || `Request failed (${status})`;
}

async function request(url, options) {
    const response = await fetch(url, options);
    if (response.ok) {
        return response.json();
    }
    throw new ApiError(response.status, errorMessage(response.status, await response.text(), response.statusText));
}

/**
 * GET /api/files. Lists a folder, or searches it and everything below when `q` is set.
 * Pass an AbortSignal so a newer request can cancel an older one.
 */
export function listFiles({ path, q, sort, dir }, signal) {
    const params = new URLSearchParams({ path, sort, dir });
    if (q) params.set('q', q);
    return request(`/api/files?${params}`, { signal });
}

function postJson(url, body) {
    return request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

/**
 * Delete, move and copy each return { succeeded, skipped, failed: [{ path, error }] }.
 * A request-level problem (such as an invalid destination) rejects with an ApiError instead.
 */
export const deleteItems = paths => postJson('/api/files/delete', { paths });
export const moveItems = (paths, destination) => postJson('/api/files/move', { paths, destination });
export const copyItems = (paths, destination) => postJson('/api/files/copy', { paths, destination });

/**
 * POST /api/files/upload. One request per file. XMLHttpRequest is used instead of fetch because
 * fetch cannot report upload progress. `onProgress` receives the number of bytes sent so far.
 */
export function uploadFile(folderPath, file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/files/upload?${new URLSearchParams({ path: folderPath })}`);
        xhr.upload.onprogress = event => {
            if (event.lengthComputable) onProgress(event.loaded);
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(JSON.parse(xhr.responseText));
            } else {
                reject(new ApiError(xhr.status, errorMessage(xhr.status, xhr.responseText, xhr.statusText)));
            }
        };
        xhr.onerror = () => reject(new ApiError(0, 'Network error'));
        xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));

        const body = new FormData();
        body.append('file', file, file.name);
        xhr.send(body);
    });
}

/**
 * Starts a browser download. One path uses a plain GET link; several paths are submitted as a form,
 * because a long selection would not fit in a URL. Both load into a hidden iframe so the page never navigates.
 *
 * A successful download is an attachment, which never fires the iframe's load event. If the event does fire,
 * the server answered with an error page instead, and its message is passed to `onError`.
 */
export function startDownload(paths, onError) {
    const frame = document.createElement('iframe');
    frame.name = 'download-' + Date.now();
    frame.hidden = true;
    frame.addEventListener('load', () => {
        let message = 'The download failed';
        try {
            const href = frame.contentWindow.location.href;
            if (href === 'about:blank') return;        // some browsers fire load for the empty frame itself
            message = JSON.parse(frame.contentDocument.body.textContent).title ?? message;
        } catch { /* keep the generic message */ }
        onError?.(message);
        frame.remove();
    });
    document.body.append(frame);

    if (paths.length === 1) {
        frame.src = `/api/files/download?${new URLSearchParams({ path: paths[0] })}`;
    } else {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = '/api/files/download';
        form.target = frame.name;
        for (const path of paths) {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'path';
            input.value = path;
            form.append(input);
        }
        document.body.append(form);
        form.submit();
        form.remove();
    }
    setTimeout(() => frame.remove(), 120_000);       // the download itself is owned by the browser by then
}
