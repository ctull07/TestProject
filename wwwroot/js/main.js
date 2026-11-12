import { Router } from './router.js';
import { FileBrowser } from './FileBrowser.js';

new FileBrowser(document.getElementById('app'), new Router()).start();
