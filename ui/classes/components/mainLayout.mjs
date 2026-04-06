import van from "../../vanjs.mjs";
import { BaseComponent } from "../baseComponent.mjs";
import { Div } from "../elements/div.mjs";
import { TabsMenu } from "./tabsMenu.mjs";
import { RawHtml } from "../elements/rawHtml.mjs";
import { VisibilityManager } from "../mixins/visibilityManager.mjs";
import { DockableWindow } from "./dockableWindow.mjs";
import { Dropdown } from "../elements/dropdown.mjs";

const { div } = van.tags;

/**
 * MainLayout
 * Wraps the viewer container and a configurable side dock. The dock can be placed on
 * the left or right, be collapsed/expanded, resized via a drag handle, and will
 * responsively move below the viewer on narrow screens.
 *
 * Usage:
 *   new MainLayout(options)
 *
 * Notes:
 * - If you provide an array of tabs via options.tabs, a TabsMenu is created automatically.
 * - Alternatively, you can pass an existing TabsMenu instance via options.menu.
 * - On narrow screens (window.innerWidth < collapseBreakpointPx), the dock is placed below.
 */

/**
 * @typedef {Object} MainLayoutTab
 * @property {string} id - Unique tab identifier.
 * @property {string} [icon] - Icon class name, e.g., "fa-circle-info".
 * @property {string} [title] - Human-readable title.
 * @property {VisibilityManager} [visibilityManager] - The visibility manager for this tab. Required.
 * @property {Array<string|import('../elements/rawHtml.mjs').RawHtml|HTMLElement>} [body] - Tab content definition.
 */

/**
 * @typedef {Object} MainLayoutOptions
 * @property {string} [id] - Root element id for the layout container.
 * @property {('left'|'right')} [position="right"] - Side where the dock appears on wide screens.
 * @property {number} [initialWidth=360] - Initial dock width in pixels.
 * @property {number} [minWidth=220] - Minimum dock width in pixels.
 * @property {number} [maxWidth=640] - Maximum dock width in pixels.
 * @property {number} [collapseBreakpointPx=900] - Viewport width (px) below which dock moves below viewer.
 * @property {MainLayoutTab[]} [tabs] - Initial array of tab definitions.
 * @property {TabsMenu} [menu] - Optional pre-built TabsMenu to attach instead of creating from tabs.
 */
export class MainLayout extends BaseComponent {
    /**
     * Create a MainLayout component.
     * @param {MainLayoutOptions} [options] - Layout configuration and initial tabs/menu.
     * @param {Array<BaseComponent|HTMLElement|string>} children - Additional child nodes/components.
     */
    constructor(options = undefined, ...children) {
        options = super(options, ...children).options;

        this.position = (options.position || "right").toLowerCase();
        this.widthPx = options.initialWidth ?? 360;
        this.minWidth = options.minWidth ?? 220;
        this.maxWidth = options.maxWidth ?? 640;
        this.collapseBreakpointPx = options.collapseBreakpointPx ?? 900;
        this.collapsed = false;

        // fullscreen-on-narrow state
        this._isFullscreen = false;
        this._prevViewerDisplay = null;
        this._prevDockInlineStyles = null;

        this._tabsArr = [];
        this._menu = options.menu || null;

        this._shellEl = this._viewerEl = this._dockEl = this._handleEl = null;
        this._viewerAreaEl = null;
        this._toolbarFloatingEl = null;
        this._toolbarEmbeddedAboveEl = null;
        this._toolbarEmbeddedBelowEl = null;
        this._toolbarEmbeddedBodyEl = null;
        this._toolbarEmbeddedHeaderEl = null;
        this._toolbarEmbeddedDropdownMountEl = null;
        this._toolbarEmbeddedTitleEl = null;
        this._toolbarEmbeddedCollapseButton = null;
        this._toolbarSwitcher = null;
        this._toolbarRegistry = new Map();
        this._toolbarActiveId = null;
        this._toolbarsEmbeddedWide = !!options.toolbarEmbeddingWide;
        this._toolbarEmbeddingPosition = options.toolbarEmbeddingPosition === "above" ? "above" : "below";
        this._toolbarsEmbeddedCollapsed = `${APPLICATION_CONTEXT.AppCache.get(`${this.id}-toolbars-embedded-collapsed`, false)}` === "true";
        this._dockViewItemId = `${this.id}-global-menu`;
        this._dockViewTabCategory = "globalMenuTabs";
        this._dockRegisteredInView = false;
        this._registeredTabViewIds = new Set();

        this._wrapperRegistry = new Map();
        this._dockedWrappers = new Map();
        this._pendingDockableRegistrations = new Set();

        this._syncingDockRequestedState = false;
        this.visibilityManager = new VisibilityManager(this._dockViewItemId).init(
            () => {
                if (!this._syncingDockRequestedState) {
                    this._dockRequestedOpen = true;
                }
                this._applyDockVisibility();
            },
            () => {
                if (!this._syncingDockRequestedState) {
                    this._dockRequestedOpen = false;
                }
                if (this._isFullscreen) {
                    this._closeFullscreen();
                }
                this._applyDockVisibility();
            }
        );

        this._dockRequestedOpen = !!this.visibilityManager?.is?.();

        if (Array.isArray(options.tabs)) {
            for (const tab of options.tabs) {
                const normalized = this._normalizeDockableTab(tab, { wrapInDockableWindow: true });
                if (!normalized) continue;
                this._tabsArr.push(normalized.tab);
                this._wrapperRegistry.set(normalized.id, normalized.wrapper);
                this._dockedWrappers.set(normalized.id, normalized.wrapper);
            }
        }
    }

    /** ---- dynamic tab API ---- */
    /**
     * Add a tab to the dock menu (creates the menu if missing).
     * Plain tab payloads are normalized into DockableWindow wrappers so they can
     * later be undocked without changing the external API.
     *
     * @param {MainLayoutTab|DockableWindow} mainLayoutTab - Tab definition or an already wrapped dockable.
     * @param {{wrapInDockableWindow?: boolean}} [options]
     * @returns {DockableWindow|null}
     */
    addTab(mainLayoutTab, options = undefined) {
        const candidateId = mainLayoutTab instanceof DockableWindow
            ? (mainLayoutTab._tabId || mainLayoutTab.id)
            : mainLayoutTab?.id;

        // Same-id reentry can happen while _normalizeDockableTab() is still
        // constructing a DockableWindow and its VisibilityManager.init() fires.
        if (candidateId && this._pendingDockableRegistrations.has(candidateId)) {
            return mainLayoutTab instanceof DockableWindow
                ? mainLayoutTab
                : this._wrapperRegistry.get(candidateId) || null;
        }

        if (candidateId) {
            this._pendingDockableRegistrations.add(candidateId);
        }

        try {
            if (!this._menu) this._ensureMenu();

            const normalized = this._normalizeDockableTab(mainLayoutTab, options);
            if (!normalized) return null;

            const { id, tab, wrapper } = normalized;

            const existingIndex = this._tabsArr.findIndex(existingTab => existingTab.id === id);
            if (existingIndex >= 0) {
                this._tabsArr.splice(existingIndex, 1, tab);
            } else {
                this._tabsArr.push(tab);
            }

            this._wrapperRegistry.set(id, wrapper);
            this._dockedWrappers.set(id, wrapper);
            wrapper.markTabRegistered?.(true);

            if (this._menu?.tabs?.[id]) {
                this._menu.remove?.(id);
                delete this._menu.tabs?.[id];
            }

            this._menu?.addTab(tab);
            this._syncMenuTabs();

            // NEW: now that the wrapper is actually registered, it is safe to
            // apply its initial cached visibility state once.
            wrapper._flushDeferredVisibilitySync?.();

            this._updateDockVisibility();
            return wrapper;
        } finally {
            if (candidateId) {
                this._pendingDockableRegistrations.delete(candidateId);
            }
        }
    }

    /**
     * Register an already created DockableWindow with the dock.
     * @param {DockableWindow} dockableWindow
     * @returns {DockableWindow|null}
     */
    addDockableWindow(dockableWindow) {
        return this.addTab(dockableWindow, { wrapInDockableWindow: false });
    }

    /**
     * Detach a docked tab from the dock while keeping its DockableWindow wrapper registered.
     * Used when a wrapper is switching from docked to floating mode.
     *
     * @param {string} id - The tab id to detach.
     * @returns {void}
     */
    detachDockableTab(id) {
        if (!this._menu) return;

        const i = this._tabsArr.findIndex(t => t.id === id);
        if (i >= 0) this._tabsArr.splice(i, 1);

        this._menu.remove?.(id);
        delete this._menu.tabs?.[id];

        const wrapper = this._dockedWrappers.get(id);
        wrapper?.markTabRegistered?.(false);
        this._dockedWrappers.delete(id);
        this._updateDockVisibility();
    }

    /**
     * Remove a tab from the dock and unregister its wrapper.
     * @param {string} id - The tab id to remove.
     * @returns {void}
     */
    removeTab(id) {
        this.detachDockableTab(id);
        this._wrapperRegistry.delete(id);
        this._registeredTabViewIds.delete(id);
    }

    /**
     * Remove all tabs from the dock menu.
     * @returns {void}
     */
    clearTabs() {
        this._tabsArr.length = 0;
        if (this._menu?.clear) {
            this._menu.clear();
        } else if (this._menu?.tabs) {
            for (const id of Object.keys(this._menu.tabs)) {
                this._menu.remove?.(id);
            }
        }

        for (const wrapper of this._dockedWrappers.values()) {
            wrapper?.markTabRegistered?.(false);
        }

        this._dockedWrappers.clear();
        this._wrapperRegistry.clear();
        this._registeredTabViewIds.clear();
        this._updateDockVisibility();
    }

    /**
     * Current number of tabs in the dock.
     * @type {number}
     */
    get tabCount() { return this._tabsArr.length; }

    /** ---- helpers ---- */
    /**
     * Returns the DOM element where the OpenSeadragon viewer should mount.
     * @returns {HTMLElement|null}
     */
    getViewerMount() { return document.getElementById("osd"); }
    /**
     * Returns the dock body container element (menu body) for injecting external content.
     * If no menu exists yet, returns the dock element itself.
     * @returns {HTMLElement|null}
     */
    getDockBodyNode() {
        return this._menu ? document.getElementById(`${this._menu.id}-body`) : this._dockEl;
    }

    /** Collapse the dock. */
    collapse() { this.collapsed = true; this._applyVisibility(); }
    /** Expand the dock. */
    expand() { this.collapsed = false; this._applyVisibility(); }
    /** Toggle the dock collapsed/expanded state. */
    toggle() {
        const narrow = typeof window !== "undefined" && window.innerWidth < this.collapseBreakpointPx;
        if (narrow) {
            this.toggleFullscreen();
        } else {
            this.collapsed ? this.expand() : this.collapse();
        }
    }

    showGlobalMenu() {
        if (!this._hasVisibleTabs()) {
            USER_INTERFACE.Dialogs.show($.t("main.globalMenu.noMenuToView"));
            this._setDockRequestedOpen(false);
            return false;
        }

        this._setDockRequestedOpen(true);
        return this._isDockEffectivelyVisible();
    }

    hideGlobalMenu() {
        this._setDockRequestedOpen(false);
        return !this._isDockEffectivelyVisible();
    }

    toggleGlobalMenu() {
        return this.isOpened()
            ? this.hideGlobalMenu()
            : this.showGlobalMenu();
    }

    showTab(id) {
        const tab = this._menu?.tabs?.[id];
        if (!tab?.visibilityManager) return false;

        tab.visibilityManager.on();
        return this.showGlobalMenu();
    }

    hideTab(id) {
        const tab = this._menu?.tabs?.[id];
        if (!tab?.visibilityManager) return false;

        tab.visibilityManager.off();

        if (!this._hasVisibleTabs()) {
            return this.hideGlobalMenu();
        }

        this._applyDockVisibility();
        return true;
    }

    isOpened() {
        const narrow = typeof window !== 'undefined' && window.innerWidth < this.collapseBreakpointPx;
        if (narrow) {
            return !!this._isFullscreen;
        }
        return this._isDockEffectivelyVisible() && !this.collapsed;
    }

    /** Toggle fullscreen overlay when in narrow viewport. */
    toggleFullscreen() {
        if (!this._isDockEffectivelyVisible()) return;
        this._isFullscreen ? this._closeFullscreen() : this._openFullscreen();
    }

    closeFullscreen() {
        this._closeFullscreen();
    }

    _openFullscreen() {
        if (!this._dockEl || !this._viewerEl || this._isFullscreen || !this._isDockEffectivelyVisible()) return;
        this._isFullscreen = true;
        // save inline state to restore later
        this._prevViewerDisplay = this._viewerEl.style.display || "";
        // also save the OSd (image) element display and top-side styles so we can keep top panel visible
        const osdEl = document.getElementById('osd');
        this._prevOsdDisplay = osdEl ? (osdEl.style.display || '') : null;
        this._osdElement = osdEl;
        const topSide = document.getElementById('top-side');
        this._topSideElement = topSide;
        if (topSide && !topSide.getAttribute('data-prev-style')) {
            const prev = {
                position: topSide.style.position || '',
                top: topSide.style.top || '',
                left: topSide.style.left || '',
                width: topSide.style.width || '',
                zIndex: topSide.style.zIndex || ''
            };
            topSide.setAttribute('data-prev-style', JSON.stringify(prev));
        }

        this._prevDockInlineStyles = {
            width: this._dockEl.style.width || "",
            height: this._dockEl.style.height || "",
        };

        // apply fullscreen styles to dock and hide viewer
        this._dockEl.style.width = "100%";
        this._dockEl.style.height = "100%";
        // hide only the image/container, keep top-side visible
        if (this._osdElement) this._osdElement.style.display = "none";
        // pin top-side to fixed so it stays visible above the fullscreen dock
        if (this._topSideElement) {
            this._topSideElement.style.position = 'fixed';
            this._topSideElement.style.top = '0';
            this._topSideElement.style.left = '0';
            this._topSideElement.style.width = '100%';
            this._topSideElement.style.zIndex = '10001';
        }
        try { document.documentElement.style.overflow = "hidden"; } catch (e) {}
    }

    _closeFullscreen() {
        if (!this._dockEl || !this._viewerEl || !this._isFullscreen) return;
        this._isFullscreen = false;
        const s = this._prevDockInlineStyles || {};
        this._dockEl.style.width = s.width;
        this._dockEl.style.height = s.height;
        // restore osd (image) display instead of whole viewer
        if (this._osdElement && this._prevOsdDisplay !== null) this._osdElement.style.display = this._prevOsdDisplay;
        else this._viewerEl.style.display = this._prevViewerDisplay;
        try { document.documentElement.style.overflow = ""; } catch (e) {}
        // restore top-side previous inline styles
        if (this._topSideElement) {
            const prevAttr = this._topSideElement.getAttribute('data-prev-style');
            if (prevAttr) {
                try {
                    const prev = JSON.parse(prevAttr);
                    this._topSideElement.style.position = prev.position || '';
                    this._topSideElement.style.top = prev.top || '';
                    this._topSideElement.style.left = prev.left || '';
                    this._topSideElement.style.width = prev.width || '';
                    this._topSideElement.style.zIndex = prev.zIndex || '';
                } catch (e) {}
                this._topSideElement.removeAttribute('data-prev-style');
            }
        }
        // ensure layout classes and visibility are correct after restoring
        this._applyResponsiveLayout();
        this._updateDockVisibility();
    }

    _setDockRequestedOpen(next) {
        const desired = !!next;

        if (this._dockRequestedOpen === desired) {
            this._applyDockVisibility();
            return true;
        }

        this._dockRequestedOpen = desired;
        this._syncingDockRequestedState = true;

        try {
            if (desired) {
                this.visibilityManager?.on?.();
            } else {
                this.visibilityManager?.off?.();
            }
        } finally {
            this._syncingDockRequestedState = false;
        }

        this._applyDockVisibility();
        return true;
    }

    /** @private */
    _normalizeDockableTab(mainLayoutTab, options = undefined) {
        const wrapInDockableWindow = options?.wrapInDockableWindow !== false;

        if (!mainLayoutTab) return null;

        if (mainLayoutTab instanceof DockableWindow) {
            const wrapper = mainLayoutTab;
            wrapper._layout = this;
            const tab = wrapper.toMainLayoutTab();
            return { id: tab.id, tab, wrapper };
        }

        if (mainLayoutTab.__dockableWindow instanceof DockableWindow) {
            const wrapper = mainLayoutTab.__dockableWindow;
            wrapper._layout = this;
            const tab = wrapper.toMainLayoutTab();
            return { id: tab.id, tab, wrapper };
        }

        if (!wrapInDockableWindow) {
            const wrapper = new DockableWindow({
                id: mainLayoutTab.id,
                title: mainLayoutTab.title || mainLayoutTab.id,
                icon: mainLayoutTab.iconName || mainLayoutTab.icon || "fa-window-maximize",
                tabId: mainLayoutTab.id,
                tabTitle: mainLayoutTab.title || mainLayoutTab.id,
                tabIcon: mainLayoutTab.iconName || mainLayoutTab.icon || "fa-window-maximize",
                defaultMode: "tab",
                layout: this,
                visibilityManager: mainLayoutTab.visibilityManager,
                floating: mainLayoutTab.floating,
            }, ...(mainLayoutTab.body || []));
            const tab = wrapper.toMainLayoutTab();
            return { id: tab.id, tab, wrapper };
        }

        const wrapper = new DockableWindow({
            id: mainLayoutTab.id,
            title: mainLayoutTab.title || mainLayoutTab.id,
            icon: mainLayoutTab.iconName || mainLayoutTab.icon || "fa-window-maximize",
            tabId: mainLayoutTab.id,
            tabTitle: mainLayoutTab.title || mainLayoutTab.id,
            tabIcon: mainLayoutTab.iconName || mainLayoutTab.icon || "fa-window-maximize",
            defaultMode: "tab",
            layout: this,
            visibilityManager: mainLayoutTab.visibilityManager,
            floating: mainLayoutTab.floating,
            onModeChange: mode => {
                if (mode === "floating") {
                    this.detachDockableTab(mainLayoutTab.id);
                } else {
                    this.addDockableWindow(wrapper);
                }
                this._updateDockVisibility();
            }
        }, ...(mainLayoutTab.body || []));

        const tab = wrapper.toMainLayoutTab();
        return { id: tab.id, tab, wrapper };
    }

    /** @private */
    _resolveDockable(tabOrId) {
        const id = typeof tabOrId === "string" ? tabOrId : tabOrId?.id;
        if (!id) return null;
        return this._dockedWrappers.get(id)
            || this._wrapperRegistry.get(id)
            || tabOrId?.__dockableWindow
            || null;
    }

    /** ---- internals ---- */
    /** @private */
    _ensureMenu() {
        if (!this._menu) {
            const menu = new TabsMenu({ id: `${this.id}-menu` }, ...this._tabsArr);
            this._menu = menu;
            if (this._dockEl) {
                menu.attachTo(this._dockEl);
                this._syncMenuTabs();
            }
        }
    }

    _getMenuTabs() {
        return Object.values(this._menu?.tabs || {});
    }

    _isTabVisible(tab) {
        if (!tab) return false;
        if (typeof tab.visibilityManager?.is === "function") {
            return !!tab.visibilityManager.is();
        }
        if (typeof tab.hidden === "boolean") {
            return !tab.hidden;
        }
        return true;
    }

    _hasVisibleTabs() {
        const tabs = this._getMenuTabs();
        const sourceTabs = tabs.length ? tabs : this._tabsArr;
        return sourceTabs.some(tab => this._isTabVisible(tab));
    }

    _isDockEffectivelyVisible() {
        return !!this._dockRequestedOpen && this._hasVisibleTabs();
    }

    _applyDockVisibility() {
        if (!this._dockEl || !this._handleEl || !this._viewerEl) return;

        const hasVisibleTabs = this._hasVisibleTabs();

        if (!hasVisibleTabs && this._dockRequestedOpen) {
            this._setDockRequestedOpen(false);
            return;
        }

        const showDock = this._dockRequestedOpen && hasVisibleTabs;

        if (!showDock && this._isFullscreen) {
            this._closeFullscreen();
        }

        if (!showDock) {
            this._dockEl.style.display = "none";
            this._handleEl.style.display = "none";
            this._viewerEl.style.flex = "1 1 100%";
            return;
        }

        this._dockEl.style.display = "";
        this._viewerEl.style.flex = "1 1 auto";
        this._applyVisibility();
    }

    /** @private */
    _updateDockVisibility() {
        this._applyDockVisibility();
    }

    /** @private */
    _applyVisibility() {
        if (!this._dockEl || !this._dockRequestedOpen || !this._hasVisibleTabs()) return;

        if (this.collapsed) {
            this._dockEl.style.width = "0px";
            this._dockEl.style.height = "0px";
            this._handleEl.style.display = "none";
        } else {
            this._dockEl.style.width = `${this.widthPx}px`;
            this._dockEl.style.height = "";
            this._handleEl.style.display = "";
        }
    }

    /** @private */
    _applyResponsiveLayout() {
        if (!this._shellEl) return;
        const narrow = window.innerWidth < this.collapseBreakpointPx;

        this._shellEl.classList.toggle("flex-col", narrow);
        this._shellEl.classList.toggle("flex-row", !narrow);
        this._viewerEl.style.order = this.position === "left" ? "1" : "0";
        this._dockEl.style.order = this.position === "left" ? "0" : "2";

        if (narrow) {
            // default collapsed on narrow; fullscreen may be toggled separately
            this.collapsed = true;
        } else {
            // leaving narrow viewport: ensure any fullscreen overlay is closed and viewer restored
            if (this._isFullscreen) this._closeFullscreen();
            this.collapsed = false;
        }

        this._applyDockVisibility();
        this.syncToolbarHost();
    }

    getToolbarFloatingContainer() {
        return this._toolbarFloatingEl;
    }

    isToolbarEmbeddingActive() {
        const narrow = typeof window !== "undefined" && window.innerWidth < this.collapseBreakpointPx;
        return narrow || this._toolbarsEmbeddedWide;
    }

    setToolbarEmbedding(enabled, placement = this._toolbarEmbeddingPosition) {
        this._toolbarsEmbeddedWide = !!enabled;
        if (placement === "above" || placement === "below") {
            this._toolbarEmbeddingPosition = placement;
        }
        this.syncToolbarHost();
        return this.isToolbarEmbeddingActive();
    }

    setToolbarEmbeddingPosition(position) {
        if (position !== "above" && position !== "below") return false;
        this._toolbarEmbeddingPosition = position;
        this.syncToolbarHost();
        return true;
    }

    registerToolbar(toolbar) {
        if (!toolbar?.id) return null;
        this._toolbarRegistry.set(toolbar.id, toolbar);
        if (!this._toolbarActiveId) {
            this._toolbarActiveId = toolbar.id;
        }

        if (!toolbar.__layoutVisibilityWrapped && toolbar.visibility) {
            const wrapMethod = (name) => {
                const original = toolbar.visibility?.[name];
                if (typeof original !== "function") return;
                toolbar.visibility[name] = (...args) => {
                    const result = original.apply(toolbar.visibility, args);
                    queueMicrotask(() => this.syncToolbarHost());
                    return result;
                };
            };
            wrapMethod("set");
            wrapMethod("on");
            wrapMethod("off");
            toolbar.__layoutVisibilityWrapped = true;
        }

        queueMicrotask(() => this.syncToolbarHost());
        return toolbar;
    }

    unregisterToolbar(toolbarOrId) {
        const id = typeof toolbarOrId === "string" ? toolbarOrId : toolbarOrId?.id;
        if (!id) return false;
        const toolbar = this._toolbarRegistry.get(id);
        if (toolbar?.setEmbedded) {
            toolbar.setEmbedded(false, { container: this._toolbarFloatingEl, active: true });
        }
        this._toolbarRegistry.delete(id);
        if (this._toolbarActiveId === id) {
            this._toolbarActiveId = null;
        }
        this.syncToolbarHost();
        return true;
    }

    focusToolbar(id) {
        if (!id || !this._toolbarRegistry.has(id)) return false;
        this._toolbarActiveId = id;
        this.syncToolbarHost();
        return true;
    }

    setEmbeddedToolbarCollapsed(next) {
        this._toolbarsEmbeddedCollapsed = !!next;
        APPLICATION_CONTEXT.AppCache.set(`${this.id}-toolbars-embedded-collapsed`, this._toolbarsEmbeddedCollapsed ? "true" : "false");
        this._renderEmbeddedToolbarHeader();
        this.syncToolbarHost();
        return this._toolbarsEmbeddedCollapsed;
    }

    toggleEmbeddedToolbarCollapsed() {
        return this.setEmbeddedToolbarCollapsed(!this._toolbarsEmbeddedCollapsed);
    }

    _getToolbarMeta(toolbar) {
        const meta = toolbar?.getEmbeddedMeta?.() || {};
        return {
            id: toolbar?.id,
            title: meta.title || toolbar?.id || $.t?.("common.toolbar") || "Toolbar",
            icon: meta.icon || "fa-wrench"
        };
    }

    _getVisibleToolbars() {
        return Array.from(this._toolbarRegistry.values()).filter(toolbar => {
            if (!toolbar) return false;
            if (toolbar.visibility?.is && toolbar.visibility.is() === false) return false;
            return true;
        });
    }

    _buildToolbarHostSlot(position) {
        const slot = document.createElement("div");
        slot.id = `${this.id}-toolbar-embedded-${position}`;
        slot.className = "hidden shrink-0 px-2 pb-2";

        const card = document.createElement("div");
        card.className = "w-full rounded-box border border-base-300 bg-base-200/95 shadow-sm backdrop-blur px-2 py-2 flex flex-col gap-2";

        const header = document.createElement("div");
        header.className = "flex items-center gap-2";

        const dropdownMount = document.createElement("div");
        dropdownMount.className = "min-w-0 flex-1";

        const title = document.createElement("div");
        title.className = "min-w-0 flex-1 truncate text-sm font-medium";
        title.style.display = "none";

        const collapse = document.createElement("button");
        collapse.type = "button";
        collapse.className = "btn btn-sm btn-ghost";
        collapse.setAttribute("title", $.t?.("common.close") || "Collapse toolbar");
        collapse.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.toggleEmbeddedToolbarCollapsed();
        });

        header.append(dropdownMount, title, collapse);

        const body = document.createElement("div");
        body.className = "w-full overflow-x-auto overflow-y-hidden";

        card.append(header, body);
        slot.append(card);

        slot._toolbarHeader = header;
        slot._toolbarDropdownMount = dropdownMount;
        slot._toolbarTitle = title;
        slot._toolbarCollapseButton = collapse;
        slot._toolbarBody = body;

        if (position === "above") {
            this._toolbarEmbeddedAboveEl = slot;
        } else {
            this._toolbarEmbeddedBelowEl = slot;
        }

        this._renderEmbeddedToolbarHeader();

        return slot;
    }

    _getActiveToolbarHostRefs() {
        const slot = this._toolbarEmbeddingPosition === "above"
            ? this._toolbarEmbeddedAboveEl
            : this._toolbarEmbeddedBelowEl;
        return {
            slot,
            header: slot?._toolbarHeader || null,
            dropdownMount: slot?._toolbarDropdownMount || null,
            title: slot?._toolbarTitle || null,
            collapseButton: slot?._toolbarCollapseButton || null,
            body: slot?._toolbarBody || null,
        };
    }

    _renderEmbeddedToolbarHeader(toolbars = this._getVisibleToolbars()) {
        const refs = this._getActiveToolbarHostRefs();
        if (!refs.collapseButton) return;
        const icon = this._toolbarsEmbeddedCollapsed ? "fa-chevron-down" : "fa-chevron-up";
        refs.collapseButton.innerHTML = `<i class="fa-solid ${icon}"></i>`;
        refs.collapseButton.setAttribute(
            "aria-label",
            this._toolbarsEmbeddedCollapsed ? "Expand toolbar" : "Collapse toolbar"
        );

        if (!refs.dropdownMount || !refs.title) return;

        const activeToolbar = toolbars.find(toolbar => toolbar.id === this._toolbarActiveId) || toolbars[0] || null;
        const meta = activeToolbar ? this._getToolbarMeta(activeToolbar) : null;

        if (toolbars.length <= 1) {
            refs.dropdownMount.style.display = "none";
            refs.title.style.display = meta ? "" : "none";
            refs.title.textContent = meta?.title || "";
            return;
        }

        refs.dropdownMount.style.display = "";
        refs.title.style.display = "none";

        const items = toolbars.map(toolbar => {
            const t = this._getToolbarMeta(toolbar);
            return {
                id: toolbar.id,
                label: t.title,
                icon: t.icon,
                onClick: () => {
                    this.focusToolbar(toolbar.id);
                }
            };
        });

        const existingSwitcherRoot = this._toolbarSwitcher
            ? document.getElementById(this._toolbarSwitcher.headerButton?.id)?.parentElement
            : null;
        if (existingSwitcherRoot && existingSwitcherRoot.parentNode !== refs.dropdownMount) {
            refs.dropdownMount.appendChild(existingSwitcherRoot);
        }

        if (!this._toolbarSwitcher) {
            this._toolbarSwitcher = new Dropdown({
                id: `${this.id}-toolbar-switcher`,
                parentId: this.id,
                title: meta?.title || "Toolbar",
                icon: meta?.icon || "fa-wrench",
                items,
                activeSelection: this._toolbarActiveId,
                selectionStyle: "check",
                closeOnItemClick: true,
                widthClass: "w-64",
                placement: "below"
            });
            this._toolbarSwitcher.attachTo(refs.dropdownMount);
        } else {
            this._toolbarSwitcher.items = {};
            items.forEach(item => {
                this._toolbarSwitcher.items[item.id] = item;
            });
            this._toolbarSwitcher.activeSelectionId = this._toolbarActiveId;
            this._toolbarSwitcher.title = meta?.title || "Toolbar";
            this._toolbarSwitcher.icon = meta?.icon || "fa-wrench";
            this._toolbarSwitcher._updateHeaderFromItem?.(meta ? { label: meta.title, icon: meta.icon } : null);
            this._toolbarSwitcher._rebuildContent?.();
            this._toolbarSwitcher.setSelected?.(this._toolbarActiveId);
        }
    }

    syncToolbarHost() {
        const floatingContainer = this._toolbarFloatingEl;
        if (!floatingContainer) return;

        const refs = this._getActiveToolbarHostRefs();
        const embeddedBody = refs.body;
        const embedded = this.isToolbarEmbeddingActive();
        const visibleToolbars = this._getVisibleToolbars();

        if (!this._toolbarActiveId || !visibleToolbars.some(toolbar => toolbar.id === this._toolbarActiveId)) {
            this._toolbarActiveId = visibleToolbars[0]?.id || null;
        }

        this._renderEmbeddedToolbarHeader(visibleToolbars);

        const activeSlot = this._toolbarEmbeddingPosition === "above"
            ? this._toolbarEmbeddedAboveEl
            : this._toolbarEmbeddedBelowEl;
        const inactiveSlot = this._toolbarEmbeddingPosition === "above"
            ? this._toolbarEmbeddedBelowEl
            : this._toolbarEmbeddedAboveEl;

        if (inactiveSlot) inactiveSlot.classList.add("hidden");

        if (!embedded || !visibleToolbars.length) {
            if (activeSlot) activeSlot.classList.add("hidden");
            for (const toolbar of this._toolbarRegistry.values()) {
                toolbar?.setEmbedded?.(false, {
                    container: floatingContainer,
                    active: true,
                });
            }
            return;
        }

        if (activeSlot) {
            activeSlot.classList.remove("hidden");
        }
        if (embeddedBody) {
            embeddedBody.style.display = this._toolbarsEmbeddedCollapsed ? "none" : "";
        }

        for (const toolbar of this._toolbarRegistry.values()) {
            const isVisibleToolbar = visibleToolbars.some(item => item.id === toolbar.id);
            const isActive = isVisibleToolbar && toolbar.id === this._toolbarActiveId;
            toolbar?.setEmbedded?.(true, {
                container: embeddedBody,
                active: isActive,
            });
        }
    }

    _ensureViewCategory() {
        const view = globalThis.USER_INTERFACE.AppBar.View;
        if (!view?.structure) return null;

        if (!view.structure[this._dockViewTabCategory]) {
            view.structure[this._dockViewTabCategory] = {
                id: "global-menu-tabs",
                label: $.t("main.globalMenu.globalMenuTabs"),
                icon: "fa-table-columns",
                section: "global-windows",
            };
            view._visualMenuNeedsRefresh = true;
        }

        return view;
    }

    _registerDockInView() {
        const view = this._ensureViewCategory();
        if (!view || this._dockRegisteredInView) return;

        view.append(
            this._dockViewItemId,
            "fa-table-columns",
            $.t("main.globalMenu.globalMenu"),
            {
                is: () => this._isDockEffectivelyVisible(),
                set: next => next
                    ? this.showGlobalMenu()
                    : this.hideGlobalMenu()
            }
        );

        this._dockRegisteredInView = true;
    }

    _registerTabInView(tab) {
        if (!tab?.id || this._registeredTabViewIds.has(tab.id)) return;
        const view = this._ensureViewCategory();
        if (!view) return;

        const wrapper = this._resolveDockable(tab);
        const viewRegistration = wrapper?.getViewRegistration?.();

        view.registerViewComponent(this._dockViewTabCategory, {
            id: viewRegistration?.id || tab.id,
            title: viewRegistration?.title || tab.title || tab.id,
            icon: viewRegistration?.icon || tab.iconName || tab.icon || "fa-window-maximize",
            visibilityManager: {
                is: () => this._isTabVisible(tab),
                set: next => next
                    ? this.showTab(tab.id)
                    : this.hideTab(tab.id)
            }
        });

        this._registeredTabViewIds.add(tab.id);
    }

    _syncMenuTabs() {
        if (!this._menu) return;
        this._registerDockInView();
        for (const tab of this._getMenuTabs()) {
            this._attachCloseButton(tab);
            this._registerTabInView(tab);
        }
    }

    _attachCloseButton(tab) {
        const headerId = tab?.headerButton?.id;
        if (!headerId) return;

        const headerEl = document.getElementById(headerId);
        if (!headerEl || headerEl.querySelector(`[data-main-layout-close="${tab.id}"]`)) return;

        headerEl.style.position = headerEl.style.position || "relative";

        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.setAttribute("data-main-layout-close", tab.id);
        closeButton.setAttribute("title", $.t("common.close"));
        closeButton.className = "btn btn-ghost btn-xs";
        closeButton.style.position = "absolute";
        closeButton.style.top = "2px";
        closeButton.style.right = "2px";
        closeButton.style.minHeight = "1rem";
        closeButton.style.height = "1rem";
        closeButton.style.width = "1rem";
        closeButton.style.padding = "0";
        closeButton.style.lineHeight = "1";
        closeButton.innerHTML = "&times;";
        closeButton.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            const wrapper = this._resolveDockable(tab);
            if (wrapper) {
                wrapper.hide?.();
            } else {
                tab.visibilityManager?.off?.();
            }
            this._applyDockVisibility();
        });

        headerEl.append(closeButton);
    }

    /** @private */
    _wireResize() {
        if (!this._handleEl) return;
        let drag = false, startX = 0, startW = 0;

        const onMove = e => {
            if (!drag) return;
            const dx = e.clientX - startX;
            const newW = this.position === "left" ? startW + dx : startW - dx;
            this.widthPx = Math.max(this.minWidth, Math.min(this.maxWidth, newW));
            this._dockEl.style.width = `${this.widthPx}px`;
            e.preventDefault();
        };
        const onUp = () => {
            drag = false;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };

        this._handleEl.addEventListener("mousedown", e => {
            if (this.collapsed || !this._isDockEffectivelyVisible()) return;
            drag = true;
            startX = e.clientX;
            startW = this._dockEl.getBoundingClientRect().width;
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
            e.preventDefault();
        });
    }

    /**
     * Create and return the root layout element. This builds the viewer area,
     * top/bottom menus containers, and the side dock with resizable handle.
     * @returns {HTMLElement} Root element to attach to the DOM.
     */
    create() {
        // --- viewer core (IDs unchanged) ---
        const osd = div({ id:"osd", style:"position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events:auto;", class:"grow relative w-full overflow-hidden" });
        const floatingToolbars = div({
            id: "toolbars-container",
            class: "absolute inset-0 pointer-events-none z-[980]"
        });
        const viewerWrap = div({ class:"relative flex-1 min-h-0" },
            osd,
            floatingToolbars,
            new RawHtml(null, `<div id="fullscreen-menu" class="bg-base-100"></div>`).create()
        );
        const embeddedAbove = this._buildToolbarHostSlot("above");
        const embeddedBelow = this._buildToolbarHostSlot("below");
        const viewerArea = div({ class:"relative flex flex-col flex-1 min-h-0 min-w-0" }, embeddedAbove, viewerWrap, embeddedBelow);

        const topSide = new Div({ id: "top-side-wrapper" }, new RawHtml(null, `
            <div id="top-side" class="flex-row w-full glass" style="display: flex; position: relative; align-items: flex-start; height: 35px; pointer-events: none;">
                <div id="top-menus" class="flex flex-row w-full" style="justify-content: space-between;">
                    <div id="top-side-left" class="flex flex-row" style="align-items: center; pointer-events: auto;"></div>
                    <div class="flex flex-row">
                        <div id="top-side-left-user" style="margin-left: 5px; margin-right: 5px; pointer-events: auto;"></div>
                        <div id="top-side-left-fullscreen" style="margin-left: 5px; pointer-events: auto;"></div>
                    </div>
                </div>
            </div>`).create());
        topSide.attachTo(document.getElementById('top-container'));


        // --- dock ---
        const dock = new Div({
            id:`${this.id}-dock`,
            extraClasses: {
                base: "bg-base-200 border-l border-base-300 shrink-0 overflow-hidden flex flex-col"
            },
            extraProperties: { style: `width:${this.widthPx}px;` }
        });

        this._dockEl = dock.create();

        if (this._tabsArr.length) {
            const menu = new TabsMenu({ id:`${this.id}-menu` }, ...this._tabsArr);
            this._menu = menu;
            menu.attachTo(this._dockEl);
        }

        const handle = div({
            id: `${this.id}-handle`,
            class: `
w-1 shrink-0 cursor-col-resize
transition-transform duration-150
hover:bg-base-300/50
hover:scale-x-300
origin-center
`
        });
        const dockNode = this._dockEl;
        const shell = div({ id:this.id, class:"absolute w-full h-full top-0 left-0 flex flex-row" },
            this.position === "left" ? [dockNode, handle, viewerArea] : [viewerArea, handle, dockNode]
        );

        this._shellEl = shell;
        this._viewerEl = viewerArea;
        this._viewerAreaEl = viewerArea;
        this._toolbarFloatingEl = floatingToolbars;
        this._handleEl = handle;

        this._syncMenuTabs();
        this._wireResize();
        this._applyResponsiveLayout();
        this._updateDockVisibility();
        this.syncToolbarHost();

        return shell;
    }

    onLayoutChange(details) {
        this._applyResponsiveLayout();
        this.syncToolbarHost();
    }
}
