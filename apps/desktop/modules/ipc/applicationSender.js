'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const PROJECT_ROOT = path.resolve(__dirname, '../..');

function isApplicationPageUrl(raw, pages = ['main.html'], projectRoot = PROJECT_ROOT) {
    try {
        const url = new URL(raw);
        if (url.protocol !== 'file:') return false;
        const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
        const actual = normalize(fileURLToPath(url));
        return pages.some(page => actual === normalize(path.join(projectRoot, page)));
    } catch { return false; }
}

// 主窗口可能被关掉后重建（macOS 点 Dock 图标），每次都现取，不认初始化时记下的旧窗口
function resolveWindowWebContents(getWindow) {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    if (!win || win.isDestroyed?.()) return null;
    return win.webContents || null;
}

function createApplicationSenderGuard({ pages = ['main.html'], projectRoot = PROJECT_ROOT, getWebContents = null, getMainWebContents = null } = {}) {
    return event => {
        try {
            const sender = event?.sender;
            const frame = event?.senderFrame;
            // 文件名后缀和 frame 自报 URL 都不能证明权限：必须是应用页面的真实顶层窗口。
            if (!sender || sender.isDestroyed() || !frame || frame !== sender.mainFrame || frame.detached) return false;
            if (sender.getType() !== 'window') return false;
            if (getWebContents && sender !== getWebContents()) return false;
            if (getMainWebContents && isApplicationPageUrl(frame.url, ['main.html'], projectRoot)) {
                const main = getMainWebContents();
                if (main && sender !== main) return false;
            }
            return isApplicationPageUrl(frame.url, pages, projectRoot) && isApplicationPageUrl(sender.getURL(), pages, projectRoot);
        } catch { return false; }
    };
}

// A privileged application preload belongs to its local document. Renderer
// navigation must not carry that bridge to remote content or another file.
// Main-process loadFile/loadURL and Loom/side-browser WebContentsViews keep
// their own existing loading/navigation owners.
function protectApplicationNavigation(contents, projectRoot = PROJECT_ROOT, fixedLocalDocument = null) {
    const fixedPage = fixedLocalDocument && new URL(fixedLocalDocument);
    if (fixedPage && (fixedPage.protocol !== 'http:' || fixedPage.hostname !== '127.0.0.1')) {
        throw new TypeError('Only an explicit loopback application document may use this navigation fence');
    }
    const blockForeignDocument = (event, target) => {
        try {
            const current = new URL(contents.getURL());
            if (fixedPage) {
                const next = new URL(target);
                const same = value => value.origin === fixedPage.origin && value.pathname === fixedPage.pathname;
                if (same(current) && same(next)) return;
                event.preventDefault();
                return;
            }
            if (current.protocol !== 'file:') return;
            const currentFile = path.resolve(fileURLToPath(current));
            const relative = path.relative(projectRoot, currentFile);
            if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
            const next = new URL(target);
            const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
            if (next.protocol === 'file:' && normalize(path.resolve(fileURLToPath(next))) === normalize(currentFile)) return;
            event.preventDefault();
        } catch { event.preventDefault(); }
    };
    contents.on('will-navigate', blockForeignDocument);
    contents.on('will-redirect', blockForeignDocument);
}

module.exports = { isApplicationPageUrl, createApplicationSenderGuard, resolveWindowWebContents, protectApplicationNavigation };
