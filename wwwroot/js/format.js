// Small pure helpers shared by the UI. No DOM access here, so they are easy to unit test.

const UNITS = ['KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    let value = bytes;
    let unit = -1;
    do {
        value /= 1024;
        unit++;
    } while (value >= 1024 && unit < UNITS.length - 1);
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function formatDate(iso) {
    return dateFormat.format(new Date(iso));
}

/** "1 file", "2 files", "1 match", "2 matches". */
export function count(n, one, many) {
    return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "/Documents/Reports/a.csv" -> "/Documents/Reports". */
export function parentPath(path) {
    return path.slice(0, path.lastIndexOf('/')) || '/';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every file name goes through this before it is placed in markup. */
export function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}
