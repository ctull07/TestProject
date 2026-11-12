import { FileBrowser } from './FileBrowser.js';
import { HOME_STATE } from './router.js';

/**
 * Hosts the whole file browser inside a modal dialog that a trigger button opens.
 *
 * The URL decides whether the dialog is open: any /browse URL means open, anything else means closed.
 * That one rule gives the rest for free:
 *
 *   - a deep link such as /browse/Documents?q=budget opens the dialog straight at that view
 *   - the trigger and the Close button are just history entries, so Back and Forward open and close it
 *   - reloading the page keeps the dialog open, exactly where it was
 *
 * A new FileBrowser is created each time the dialog opens and destroyed when it closes, so nothing
 * keeps running behind a closed dialog.
 */
export class FileBrowserDialog {
    #trigger;
    #router;
    #dialog = null;
    #browser = null;
    #lastState = HOME_STATE;       // where the user was last time, so reopening continues there

    constructor({ trigger, router }) {
        this.#trigger = trigger;
        this.#router = router;
    }

    start() {
        this.#trigger.addEventListener('click', () => {
            this.#router.push(this.#lastState);
            this.#syncWithUrl();
        });
        // Registered before any FileBrowser exists, so on Back/Forward this runs first and can close the
        // dialog (which unsubscribes the browser) before the browser reacts to an address it no longer owns.
        this.#router.onPop(() => this.#syncWithUrl());
        this.#syncWithUrl();                     // a deep link may already point inside the dialog
    }

    #syncWithUrl() {
        const shouldBeOpen = this.#router.isBrowsing;
        if (shouldBeOpen && !this.#dialog) this.#open();
        else if (!shouldBeOpen && this.#dialog) this.#close();
    }

    #open() {
        const dialog = document.createElement('dialog');
        dialog.className = 'browser-dialog';
        dialog.setAttribute('aria-labelledby', 'browser-dialog-title');
        dialog.innerHTML = `
            <header class="browser-dialog-head">
                <h2 id="browser-dialog-title">Files</h2>
                <button type="button" class="btn small" data-close>Close</button>
            </header>
            <div class="browser-dialog-body"></div>`;
        document.body.append(dialog);

        dialog.querySelector('[data-close]').addEventListener('click', () => this.#requestClose());
        // Escape. Cancelling the native close lets us go through the same path as the Close button.
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            this.#requestClose();
        });
        // A browser may skip the cancel event (for example on a quick second Escape). Keep the URL honest anyway.
        dialog.addEventListener('close', () => {
            if (this.#dialog === dialog) {
                this.#router.pushHome();
                this.#syncWithUrl();
            }
        });

        this.#dialog = dialog;
        this.#browser = new FileBrowser(dialog.querySelector('.browser-dialog-body'), this.#router);
        dialog.showModal();
        this.#browser.start();
    }

    /** Close button and Escape. Refuses while work is running, because closing would hide its progress and result. */
    #requestClose() {
        if (this.#browser.busy) {
            this.#browser.notify('An upload or file operation is still running. Close this when it finishes.', true);
            return;
        }
        this.#router.pushHome();
        this.#syncWithUrl();
    }

    #close() {
        const dialog = this.#dialog;
        this.#lastState = this.#browser.state;
        this.#dialog = null;                     // before close(), so the "close" listener above ignores this one
        this.#browser.destroy();
        this.#browser = null;
        dialog.close();
        dialog.remove();
        document.title = 'File Browser';
        this.#trigger.focus();
    }
}
