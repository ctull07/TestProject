// Thin client for the server's JSON API. Nothing in here touches the DOM.

export class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function request(url, options) {
    const response = await fetch(url, options);
    if (response.ok) {
        return response.json();
    }
    // The server answers failures with RFC 7807 problem details; "title" holds the message.
    let message = response.statusText || 'Request failed';
    try {
        const problem = await response.json();
        if (problem.title) message = problem.title;
    } catch { /* body was not JSON, keep the status text */ }
    throw new ApiError(response.status, message);
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
