import { sealActiveHtmlRoot, mountIsolatedHtmlIslands, cleanupIsolatedHtmlIslands } from './isolatedHtmlFrame.js';
// modules/renderer/animation.js

// --- CDN URL Mapping ---
const CDN_TO_LOCAL_MAP = {
    'https://cdnjs.cloudflare.com/ajax/libs/three.js': 'vendor/three.min.js',
    'https://cdn.jsdelivr.net/npm/three': 'vendor/three.min.js',
    'https://unpkg.com/three': 'vendor/three.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/animejs': 'vendor/anime.min.js',
    'https://cdn.jsdelivr.net/npm/animejs': 'vendor/anime.min.js',
    'https://unpkg.com/animejs': 'vendor/anime.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pixi.js': 'vendor/pixi.min.js',
    'https://cdn.jsdelivr.net/npm/pixi.js': 'vendor/pixi.min.js',
    'https://unpkg.com/pixi.js': 'vendor/pixi.min.js',
};

// 🔥 全局跟踪已加载的脚本，防止跨消息重复加载
if (!window._vcp_loaded_scripts) {
    window._vcp_loaded_scripts = new Set();
}

if (window.PIXI) {
    window._vcp_loaded_scripts.add('vendor/pixi.min.js');
}

function replaceCdnUrls(scriptContent) {
    if (!scriptContent || typeof scriptContent !== 'string') {
        return scriptContent;
    }
    
    let processed = scriptContent;
    
    const threeJsPatterns = [
        /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/[^'"`);\s]*/gi,
        /https?:\/\/cdn\.jsdelivr\.net\/npm\/three(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
        /https?:\/\/unpkg\.com\/three(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
    ];
    
    threeJsPatterns.forEach(pattern => {
        processed = processed.replace(pattern, 'vendor/three.min.js');
    });
    
    const animeJsPatterns = [
        /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/animejs\/[^'"`);\s]*/gi,
        /https?:\/\/cdn\.jsdelivr\.net\/npm\/animejs(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
        /https?:\/\/unpkg\.com\/animejs(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
    ];
    
    animeJsPatterns.forEach(pattern => {
        processed = processed.replace(pattern, 'vendor/anime.min.js');
    });
    
    const pixiJsPatterns = [
        /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pixi\.js\/[^'"`);\s]*/gi,
        /https?:\/\/cdn\.jsdelivr\.net\/npm\/pixi\.js(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
        /https?:\/\/unpkg\.com\/pixi\.js(?:@[^\/'"`);\s]+)?\/[^'"`);\s]*/gi,
    ];

    pixiJsPatterns.forEach(pattern => {
        processed = processed.replace(pattern, 'vendor/pixi.min.js');
    });

    const genericCdnPatterns = [
        { pattern: /https?:\/\/[^'"`);\s]*(?:three\.js|three)[^'"`);\s]*\/[^'"`);\s]*\.js(?:\?[^'"`);\s]*)?/gi, replacement: 'vendor/three.min.js' },
        { pattern: /https?:\/\/[^'"`);\s]*(?:animejs|anime)[^'"`);\s]*\/[^'"`);\s]*\.js(?:\?[^'"`);\s]*)?/gi, replacement: 'vendor/anime.min.js' },
        { pattern: /https?:\/\/[^'"`);\s]*(?:pixi\.js|pixijs|pixi)[^'"`);\s]*\/[^'"`);\s]*\.js(?:\?[^'"`);\s]*)?/gi, replacement: 'vendor/pixi.min.js' },
    ];
    
    genericCdnPatterns.forEach(({ pattern, replacement }) => {
        processed = processed.replace(pattern, replacement);
    });
    
    return processed;
}

const trackedThreeInstances = new Map();
const visibilityOwnerByContent = new WeakMap();
let isThreePatched = false;

function patchThreeJS() {
    if (isThreePatched || !window.THREE || !window.THREE.WebGLRenderer) return;

    const OriginalWebGLRenderer = window.THREE.WebGLRenderer;

    window.THREE.WebGLRenderer = function(...args) {
        const renderer = new OriginalWebGLRenderer(...args);

        const originalRender = renderer.render;
        let associatedScene = null;
        let associatedCamera = null;

        renderer.render = function(scene, camera) {
            if (this._disposed) {
                return;
            }
            
            if (scene && !associatedScene) {
                associatedScene = scene;
            }
            if (camera && !associatedCamera) {
                associatedCamera = camera;
            }
            
            if (!document.body.contains(this.domElement)) {
                if (!this._disposed) this.dispose();
                return;
            }
            
            try {
                return originalRender.call(this, scene, camera);
            } catch (error) {
                console.error('[Three.js Safety] Render error caught:', error);
                if (!this._disposed) this.dispose();
                return;
            }
        };

        const originalDispose = renderer.dispose;
        renderer.dispose = function() {
            if (this._disposed) return;
            this._disposed = true;
            // This observer is owned by the renderer. Disconnect it before
            // releasing GPU resources so a detached canvas cannot retain the
            // document or re-register itself after teardown.
            this._vcpMutationObserver?.disconnect?.();
            this._vcpMutationObserver = null;
            if (originalDispose) {
                return originalDispose.call(this);
            }
        };

        const observer = new MutationObserver(() => {
            if (document.body.contains(renderer.domElement)) {
                const contentDiv = renderer.domElement.closest('.md-content');
                if (contentDiv) {
                    const visibilityOptimizer = visibilityOwnerByContent.get(contentDiv);
                    if (!trackedThreeInstances.has(contentDiv)) {
                        trackedThreeInstances.set(contentDiv, []);
                    }
                    const instance = {
                        renderer,
                        getScene: () => associatedScene,
                    };
                    trackedThreeInstances.get(contentDiv).push(instance);

                    // 注册到可见性优化器
                    const messageItem = contentDiv.closest('.message-item');
                    if (messageItem) {
                        visibilityOptimizer.registerThreeContext(messageItem, {
                            renderer,
                            getScene: () => associatedScene,
                            getCamera: () => associatedCamera,
                            // 注意：这里无法直接获取外部的 renderLoop，
                            // 但我们可以通过拦截 setAnimationLoop 来获取
                        });
                    }
                }
                observer.disconnect();
            }
        });

        renderer._vcpMutationObserver = observer;

        observer.observe(document.body, { childList: true, subtree: true });

        return renderer;
    };

    window.THREE.WebGLRenderer.prototype = OriginalWebGLRenderer.prototype;
    isThreePatched = true;
    console.log('[Three.js Patch] THREE.WebGLRenderer patched with safety checks.');
}

function createMessagePixiFacade(messageItem, visibilityOptimizer) {
    const originalPixi = window.PIXI;
    if (!originalPixi?.Application || !messageItem || !visibilityOptimizer?.registerPixiContext) {
        return originalPixi;
    }

    const OriginalApplication = originalPixi.Application;

    function MessageOwnedApplication(...args) {
        const app = Reflect.construct(OriginalApplication, args, new.target === MessageOwnedApplication
            ? OriginalApplication
            : new.target);
        const originalInit = typeof app.init === 'function' ? app.init.bind(app) : null;
        const originalStart = typeof app.start === 'function' ? app.start.bind(app) : null;
        const originalStop = typeof app.stop === 'function' ? app.stop.bind(app) : null;
        const originalDestroy = typeof app.destroy === 'function' ? app.destroy.bind(app) : null;

        const context = {
            app,
            isReady: !originalInit,
            isPaused: true,
            isDestroyed: false,
            pause() {
                if (context.isDestroyed) return;
                try { originalStop?.(); } catch (error) { /* partially initialized */ }
                try { app.ticker?.stop?.(); } catch (error) { /* partially initialized */ }
            },
            resume() {
                if (context.isDestroyed || !context.isReady) return;
                try {
                    if (originalStart) originalStart();
                    else app.ticker?.start?.();
                } catch (error) {
                    console.warn('[Animation] Pixi resume failed:', error);
                }
            },
            destroy() {
                if (context.isDestroyed) return;
                context.isDestroyed = true;
                context.pause();
                const canvas = app.canvas || app.view;
                try {
                    originalDestroy?.(
                        { removeView: true },
                        { children: true, texture: true, textureSource: true }
                    );
                } catch (error) {
                    console.warn('[Animation] Pixi destroy failed:', error);
                }
                canvas?.remove?.();
            }
        };

        // AI 的显式 start 也必须经过气泡热区与话题配额，不得绕过调度器。
        app.start = () => {
            visibilityOptimizer.registerPixiContext(messageItem, context);
        };
        app.stop = () => {
            context.pause();
            context.isPaused = true;
        };
        app.destroy = (...destroyArgs) => {
            if (context.isDestroyed) return;
            context.isDestroyed = true;
            try {
                originalStop?.();
                app.ticker?.stop?.();
                return originalDestroy?.(...destroyArgs);
            } finally {
                (app.canvas || app.view)?.remove?.();
            }
        };

        if (originalInit) {
            app.init = async (options = {}) => {
                const result = await originalInit({ ...options, autoStart: false });
                context.isReady = true;
                visibilityOptimizer.registerPixiContext(messageItem, context);
                return result;
            };
        }

        // 构造即登记并冻结；Pixi v8 会在 init 完成后再次登记。
        visibilityOptimizer.registerPixiContext(messageItem, context);
        return app;
    }

    MessageOwnedApplication.prototype = OriginalApplication.prototype;
    Object.setPrototypeOf(MessageOwnedApplication, OriginalApplication);

    return new Proxy(originalPixi, {
        get(target, prop, receiver) {
            if (prop === 'Application') return MessageOwnedApplication;
            return Reflect.get(target, prop, receiver);
        }
    });
}

function loadScript(src, onLoad, onError) {
    if (window._vcp_loaded_scripts.has(src)) {
        if(onLoad) onLoad();
        return;
    }
    window._vcp_loaded_scripts.add(src); // Pre-mark to prevent race conditions
    
    const scriptEl = document.createElement('script');
    scriptEl.src = src;
    scriptEl.onload = () => {
        console.log(`[Animation] ✅ Library loaded: ${src}`);
        if (onLoad) onLoad();
    };
    scriptEl.onerror = () => {
        console.error(`[Animation] ❌ Failed to load: ${src}`);
        window._vcp_loaded_scripts.delete(src); // Allow retry on failure
        if (onError) onError();
    };
    document.head.appendChild(scriptEl);
}

function processScripts(containerElement, visibilityOptimizer) {
    if (visibilityOptimizer) visibilityOwnerByContent.set(containerElement, visibilityOptimizer);
    // Normal insertion paths seal in an inert template. This also handles
    // existing DOM supplied by trusted renderer callers without host eval.
    sealActiveHtmlRoot(containerElement);
    mountIsolatedHtmlIslands(containerElement, { visibilityOptimizer });
}

export function processAnimationsInContent(containerElement, visibilityOptimizer = null) {
    if (!containerElement) return;
    processScripts(containerElement, visibilityOptimizer);
}


export function cleanupAnimationsInContent(contentDiv) {
    if (!contentDiv) return;
    cleanupIsolatedHtmlIslands(contentDiv);
    const visibilityOptimizer = visibilityOwnerByContent.get(contentDiv);
    const messageItem = contentDiv.closest?.('.message-item');
    visibilityOptimizer?.destroyPixiMessage?.(messageItem);
    visibilityOwnerByContent.delete(contentDiv);

    if (window.anime) {
        const animatedElements = contentDiv.querySelectorAll('*');
        if (animatedElements.length > 0) anime.remove(animatedElements);
    }

    if (trackedThreeInstances.has(contentDiv)) {
        const instancesToClean = trackedThreeInstances.get(contentDiv);
        console.log(`[Cleanup] Cleaning ${instancesToClean.length} Three.js instance(s)`);

        instancesToClean.forEach(instance => {
            if (instance.renderer && !instance.renderer._disposed) {
                const scene = instance.getScene();
                if (scene) {
                    scene.traverse(object => {
                        if (object.isMesh) {
                            if (object.geometry) object.geometry.dispose();
                            if (object.material) {
                                if (Array.isArray(object.material)) {
                                    object.material.forEach(mat => { if (mat.dispose) mat.dispose(); });
                                } else if (object.material.dispose) {
                                    object.material.dispose();
                                }
                            }
                        }
                    });
                }
                try {
                    instance.renderer.dispose();
                } catch (e) {
                    console.warn('[Cleanup] Error during renderer disposal:', e);
                }
            }
        });

        trackedThreeInstances.delete(contentDiv);
    }
}

export function animateMessageIn(messageItem) {
    if (!window.anime) return;
    messageItem.style.opacity = 0;
    messageItem.style.transform = 'translateY(20px)';
    anime({
        targets: messageItem,
        opacity: 1,
        translateY: 0,
        duration: 500,
        easing: 'easeOutExpo',
        complete: () => {
            messageItem.style.opacity = '';
            messageItem.style.transform = '';
        }
    });
}

export function animateMessageOut(messageItem, onComplete) {
    if (!window.anime) {
        if (onComplete) onComplete();
        return;
    }
    anime({
        targets: messageItem,
        opacity: 0,
        translateY: -20,
        duration: 400,
        easing: 'easeInExpo',
        complete: onComplete
    });
}
