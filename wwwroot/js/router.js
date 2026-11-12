// Deep linking. The whole UI state lives in the address bar:
//
//   /browse/Documents/Reports?q=budget&sort=size&dir=desc
//
// toUrl() and fromLocation() are exact inverses, so any URL the app produces restores the same view when pasted.

export const SORT_FIELDS = ['name', 'size', 'modified'];

export const HOME_STATE = Object.freeze({ path: '/', q: '', sort: 'name', dir: 'asc' });

export function toUrl(state) {
    const segments = state.path.split('/').filter(Boolean).map(encodeURIComponent);
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.sort !== HOME_STATE.sort) params.set('sort', state.sort);
    if (state.dir !== HOME_STATE.dir) params.set('dir', state.dir);
    const query = params.toString();
    return '/browse' + segments.map(s => '/' + s).join('') + (query ? '?' + query : '');
}

/** Accepts anything with pathname and search, so it works for window.location and for URL objects. */
export function fromLocation({ pathname, search }) {
    const segments = pathname.split('/').filter(Boolean);
    if (segments[0] === 'browse') segments.shift();
    const params = new URLSearchParams(search);
    const sort = params.get('sort');
    return {
        path: '/' + segments.map(safeDecode).join('/'),
        q: params.get('q') ?? '',
        sort: SORT_FIELDS.includes(sort) ? sort : HOME_STATE.sort,
        dir: params.get('dir') === 'desc' ? 'desc' : HOME_STATE.dir
    };
}

function safeDecode(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;   // a stray "%" in a hand-typed URL should not crash the app
    }
}

export class Router {
    get current() {
        return fromLocation(location);
    }

    /** Adds a history entry: Back returns to the previous view. */
    push(state) {
        history.pushState(null, '', toUrl(state));
    }

    /** Rewrites the current entry. Used for search and sort so Back does not step through every keystroke. */
    replace(state) {
        history.replaceState(null, '', toUrl(state));
    }

    /** Calls back with the new state when the user presses Back or Forward. */
    onPop(callback) {
        addEventListener('popstate', () => callback(this.current));
    }
}
