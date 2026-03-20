import { createCommentsWindow, finalizeCommentsWindowMount } from '../comments/commentsWindow.mjs';
import { AnnotationBoardPanel } from '../board/annotationBoardPanel.mjs';

const { div, button, input, span } = globalThis.van.tags;

function iconButton(icon, title, onClick, active = false) {
    return button({
        type: 'button',
        class: `btn btn-ghost btn-sm btn-square ${active ? 'btn-active' : ''}`.trim(),
        title,
        onclick: onClick,
    }, span({ class: `fa-auto ${icon}` }));
}

function tabButton(label, onClick, active = false, hidden = false) {
    return button({
        type: 'button',
        class: `btn btn-sm rounded-none border-b-0 flex-1 ${active ? 'btn-active' : ''}`.trim(),
        onclick: onClick,
        style: hidden ? 'display:none;' : ''
    }, label);
}

export const viewerMenuMethods = {
    setDrawOutline(enable) {
        // todo no way to change this for a single viewer for now -> presets are global
        this.context.setAnnotationCommonVisualProperty('modeOutline', enable);
        this._updateViewerControls();
    },

    setEdgeCursorNavigate(enable, viewerId) {
        enable = this.context.getFabric(viewerId)?.setCloseEdgeMouseNavigation(enable) || false;
        this.setOption('edgeCursorNavigate', enable);
        this._updateViewerControls(viewerId);
        return enable;
    },

    _resolveViewerId(viewerOrId = undefined) {
        if (!viewerOrId) return VIEWER?.uniqueId;
        return typeof viewerOrId === 'object' ? viewerOrId.uniqueId : viewerOrId;
    },

    _getViewerUI(viewerOrId = undefined) {
        const viewerId = this._resolveViewerId(viewerOrId);
        if (!viewerId) return undefined;
        return this.getViewerContext(viewerId);
    },

    _toggleStrokeStyling(enable) {
        Object.values(VIEWER_MANAGER?.viewers || []).forEach(viewer => {
            const state = this._getViewerUI(viewer.uniqueId);
            if (!state?.authorTabButton) return;
            state.authorTabButton.style.display = enable ? '' : 'none';
            if (!enable && state.currentTab === 'authors') {
                this.switchMenuList('preset', viewer.uniqueId);
            }
        });
    },

    initHTML() {
        USER_INTERFACE.addHtml(createCommentsWindow(this), this.id);
        finalizeCommentsWindowMount(this);

        this.context.addHandler('annotation-selected', (e) => this._annotationSelected(e.object));
        this.context.addHandler('annotation-deselected', (e) => this._annotationDeselected(e.object));

        this.context.addHandler('annotation-board-save-request', (e) => {
            const viewerId = e?.viewer ? this._resolveViewerId(e.viewer) : undefined;
            if (viewerId) {
                this._getViewerUI(viewerId)?.boardPanel?.commitEdit();
            } else {
                VIEWER_MANAGER.viewers.forEach(viewer => this._getViewerUI(viewer.uniqueId)?.boardPanel?.commitEdit());
            }
        });

        this.context.addHandler('annotation-board-refresh-request', (e) => {
            const viewerId = e?.viewer ? this._resolveViewerId(e.viewer) : undefined;
            if (viewerId) {
                this._getViewerUI(viewerId)?.boardPanel?.requestRender();
            } else {
                this._refreshAllBoardPanels();
            }
        });

        const boardRefresh = () => this._refreshAllBoardPanels();
        const sideRefresh = () => {
            this._refreshAllBoardPanels();
            this._refreshAllPresetLists();
            this._refreshAllAuthorLists();
        };

        this.context.addFabricHandler('layer-selection-changed', boardRefresh);
        this.context.addFabricHandler('active-layer-changed', boardRefresh);
        this.context.addFabricHandler('annotation-selection-changed', boardRefresh);
        this.context.addFabricHandler('layer-objects-changed', sideRefresh);
        this.context.addHandler('annotation-preset-change', sideRefresh);
        this.context.addHandler('annotation-create', sideRefresh);
        this.context.addHandler('annotation-delete', sideRefresh);
        this.context.addHandler('annotation-replace', sideRefresh);
        this.context.addHandler('import', sideRefresh);
        this.context.addHandler('layer-added', sideRefresh);
        this.context.addHandler('layer-removed', sideRefresh);

        // as a last resort save by exporting to a file
        this.context.addHandler('save-annotations', async (e) => {
            await this.exportToFile();
            e.setHandled(this.t('annotations.export.downloadFallbackHandled'));
        }, null, -Infinity);

        VIEWER_MANAGER.addHandler('viewer-destroy', (e) => {
            const state = this._getViewerUI(e.uniqueId);
            state?.boardPanel?.destroy?.();
        });

        this.registerViewerMenu((viewer) => {
            const viewerId = viewer.uniqueId;
            const state = this.getViewerContext(viewerId);
            state.viewer = viewer;
            state.currentTab = state.currentTab || 'preset';

            const fabric = this.context.getFabric(viewerId);
            if (fabric) fabric.focusWithScreen = this._focusWithZoom;

            state.boardPanel?.destroy?.();
            state.boardPanel = new AnnotationBoardPanel(this, viewer);

            state.enableButton = iconButton('fa-eye', this.t('annotations.viewerMenu.toggleVisibility'), (e) => this._toggleEnabled(e.currentTarget));
            state.outlineButton = iconButton('fa-vector-square', this.t('annotations.viewerMenu.outlineOnly'), () => {
                const next = !this.context.getAnnotationCommonVisualProperty('modeOutline');
                this.setDrawOutline(next);
            }, this.context.getAnnotationCommonVisualProperty('modeOutline'));
            state.edgeButton = iconButton('fa-up-down-left-right', this.t('annotations.viewerMenu.edgeNavigation'), () => {
                const active = !(state.edgeButton.classList.contains('btn-active'));
                this.setEdgeCursorNavigate(active, viewerId);
            }, this.getOption('edgeCursorNavigate', true));
            state.saveButton = iconButton('fa-floppy-disk', this.t('annotations.viewerMenu.save'), () => {
                this.context.requestExport()
                    .then((msg) => Dialogs.show(msg))
                    .catch((e) => Dialogs.show(`${this.t('annotations.export.saveFailed')} ${e.message}`, 5000, Dialogs.MSG_ERR));
            });
            state.moreButton = iconButton('fa-ellipsis-vertical', this.t('annotations.viewerMenu.moreOptions'), () => {
                USER_INTERFACE.AppBar.Plugins.openSubmenu(this.id, 'annotations-shared');
            });

            state.borderInput = input({
                type: 'range', min: '1', max: '10', step: '1',
                class: 'range range-xs range-primary w-full',
                value: String(this.context.getAnnotationCommonVisualProperty('originalStrokeWidth')),
                oninput: (e) => {
                    if (this.context.disabledInteraction) return;
                    this.context.setAnnotationCommonVisualProperty('originalStrokeWidth', Number.parseFloat(e.currentTarget.value));
                }
            });

            state.opacityInput = input({
                type: 'range', min: '0', max: '1', step: '0.1',
                class: 'range range-xs range-primary w-full',
                value: String(this.context.getAnnotationCommonVisualProperty('opacity')),
                oninput: (e) => {
                    if (this.context.disabledInteraction) return;
                    this.context.setAnnotationCommonVisualProperty('opacity', Number.parseFloat(e.currentTarget.value));
                }
            });

            state.presetTabButton = tabButton(this.t('annotations.viewerMenu.tabs.classes'), () => this.switchMenuList('preset', viewerId), state.currentTab === 'preset');
            state.annotationTabButton = tabButton(this.t('annotations.viewerMenu.tabs.annotations'), () => this.switchMenuList('annot', viewerId), state.currentTab === 'annot');
            state.authorTabButton = tabButton(this.t('annotations.viewerMenu.tabs.authors'), () => this.switchMenuList('authors', viewerId), state.currentTab === 'authors', !this.context.strokeStyling);

            state.presetInner = div({ class: 'space-y-1' });
            state.presetList = div({ class: `flex-1 pl-2 pr-1 mt-2 relative ${state.currentTab === 'preset' ? '' : 'hidden'}`.trim() },
                button({ type: 'button', class: 'btn btn-xs absolute top-0 right-4 z-10', onclick: () => this.showPresets() },
                    span({ class: 'fa-auto fa-pen-to-square mr-1 text-xs' }),
                    this.t('annotations.viewerMenu.editPresets')
                ),
                div({ class: 'pt-7' }, state.presetInner)
            );

            state.annotationList = div({ class: `mx-2 mt-2 flex-1 min-h-0 ${state.currentTab === 'annot' ? '' : 'hidden'}`.trim() },
                state.boardPanel.create()
            );

            state.authorInner = div({ class: 'space-y-1' });
            state.authorList = div({ class: `mx-2 mt-2 ${state.currentTab === 'authors' ? '' : 'hidden'}`.trim() }, state.authorInner);

            const body = div({ class: 'flex flex-col w-full h-full' },
                div({ class: 'flex flex-row items-center justify-between w-full mb-2 px-1' },
                    state.enableButton,
                    state.outlineButton,
                    state.edgeButton,
                    state.saveButton,
                    state.moreButton
                ),
                div({ class: 'flex flex-row w-full gap-2 mb-2' },
                    div({ class: 'flex-1' },
                        div({ class: 'text-xs mb-1 opacity-70' }, this.t('annotations.viewerMenu.border')),
                        state.borderInput
                    ),
                    div({ class: 'flex-1' },
                        div({ class: 'text-xs mb-1 opacity-70' }, this.t('annotations.viewerMenu.opacity')),
                        state.opacityInput
                    )
                ),
                div({ class: 'join join-horizontal w-full border-b border-base-300' },
                    state.presetTabButton,
                    state.annotationTabButton,
                    state.authorTabButton
                ),
                state.presetList,
                state.annotationList,
                state.authorList
            );

            requestAnimationFrame(() => {
                this._renderPresetList(viewerId);
                this._populateAuthorsList(viewerId);
                if (state.currentTab === 'annot') state.boardPanel.mount();
                this._updateViewerControls(viewerId);
            });

            return {
                id: this.id,
                title: this.t('annotations.viewerMenu.title'),
                icon: 'fa-question-circle',
                body
            };
        });
        setTimeout(() => {
            const ui = window.UI;
            const modes = this.context.Modes;

            const gHistory = new ui.ToolbarGroup({ id: 'g-history' },
                new ui.ToolbarItem({
                    id: 'toolbar-history-undo',
                    icon: 'fa-rotate-left',
                    label: this.t('annotations.toolbar.undo'),
                    onClick: () => this.context.undo()
                }),
                new ui.ToolbarItem({
                    id: 'toolbar-history-redo',
                    icon: 'fa-rotate-right',
                    label: this.t('annotations.toolbar.redo'),
                    onClick: () => this.context.redo()
                }),
                new ui.ToolbarItem({
                    id: 'toolbar-history-board',
                    icon: 'fa-list',
                    label: this.t('annotations.toolbar.history'),
                    onClick: () => this.switchMenuList('annot')
                }),
                new ui.ToolbarItem({
                    id: 'toolbar-history-metrics',
                    icon: 'fa-square-poll-horizontal',
                    label: this.t('annotations.toolbar.measurements'),
                    onClick: () => this.showMeasurementsWindow()
                })
            );

            const factories = this._allowedFactories
                .map((factoryId) => this.context.getAnnotationObjectFactory(factoryId))
                .filter(Boolean);

            const gModes = new ui.ToolbarGroup({
                itemID: 'g-modes',
                selectable: true,
                defaultSelected: modes.AUTO.getId(),
                extraClasses: { padding: 'mx-2' }
            });

            new ui.ToolbarItem({
                itemID: modes.AUTO.getId(),
                icon: modes.AUTO.getIcon(),
                label: modes.AUTO.getDescription(),
                onClick: () => {
                    this.switchModeActive(modes.AUTO.getId());
                }
            }).attachTo(gModes);

            this._shapeChoice = new ui.ToolbarChoiceGroup({
                headerMode: 'selectOrExpand',
                itemID: 'cg-shapes',
                defaultSelected: factories[0]?.id || 'none',
                onChange: (factoryId) => {
                    this.switchModeActive(modes.CUSTOM.getId(), factoryId, true);
                }
            }, ...factories.map((factory) => new ui.ToolbarItem({
                itemID: factory.factoryID,
                icon: factory.getIcon(),
                label: `${modes.CUSTOM.getDescription()}: ${factory.title()}`
            }))).attachTo(gModes);

            this._gBrush = new ui.ToolbarGroup({ id: 'g-brush', itemID: 'g-brush', selectable: true },
                new ui.ToolbarItem({
                    itemID: modes.FREE_FORM_TOOL_ADD.getId(),
                    icon: modes.FREE_FORM_TOOL_ADD.getIcon(),
                    label: modes.FREE_FORM_TOOL_ADD.getDescription(),
                    onClick: () => {
                        this.switchModeActive(modes.FREE_FORM_TOOL_ADD.getId());
                    },
                    extraClasses: { icon: 'thumb-add' }
                }),
                new ui.ToolbarItem({
                    itemID: modes.FREE_FORM_TOOL_REMOVE.getId(),
                    icon: modes.FREE_FORM_TOOL_REMOVE.getIcon(),
                    label: modes.FREE_FORM_TOOL_REMOVE.getDescription(),
                    onClick: () => {
                        this.switchModeActive(modes.FREE_FORM_TOOL_REMOVE.getId());
                    },
                    extraClasses: { icon: 'thumb-remove' }
                })
            ).attachTo(gModes);

            this._autoChoice = new ui.ToolbarChoiceGroup({
                    itemID: 'cg-auto',
                    defaultSelected: modes.MAGIC_WAND.getId(),
                    onChange: (id) => {
                        this.switchModeActive(id);
                    }
                },
                new ui.ToolbarItem({
                    itemID: modes.MAGIC_WAND.getId(),
                    icon: modes.MAGIC_WAND.getIcon(),
                    label: modes.MAGIC_WAND.getDescription()
                }),
                new ui.ToolbarItem({
                    itemID: modes.FREE_FORM_TOOL_CORRECT.getId(),
                    icon: modes.FREE_FORM_TOOL_CORRECT.getIcon(),
                    label: modes.FREE_FORM_TOOL_CORRECT.getDescription()
                }),
                new ui.ToolbarItem({
                    itemID: modes.VIEWPORT_SEGMENTATION.getId(),
                    icon: modes.VIEWPORT_SEGMENTATION.getIcon(),
                    label: modes.VIEWPORT_SEGMENTATION.getDescription()
                })).attachTo(gModes);
            this._gModes = gModes;

            this._htmlWrap = new UI.RawHtml({
                id: `${this.id}-mode-options-html`,
                extraClasses: { base: 'w-full h-full text-sm' }
            }, this.context.mode.customHtml() || '');

            this._modeOptionsPanel = new UI.ToolbarPanelButton({
                id: 'mode-options',
                itemID: 'mode-options',
                icon: 'fa-sliders',
                label: this.t('annotations.toolbar.modeOptions'),
                panelClass: 'w-80 max-h-[60vh] overflow-y-auto space-y-2',
                onToggle: (open) => {
                    if (!open) this._forceCloseModeOptions = true;
                }
            }, this._htmlWrap);

            USER_INTERFACE.Tools.setMenu(this.id, 'annotations-tool-bar', this.t('annotations.toolbar.title'),
                [gHistory, new UI.ToolbarSeparator(), gModes, new UI.ToolbarSeparator(), this._modeOptionsPanel],
                'draw'
            );
        }, 2000);

        USER_INTERFACE.AppBar.Plugins.setMenu(this.id, 'annotations-shared', this.t('annotations.export.menuTitle'),
            `<h3 class="f2-light">${this.t('annotations.export.menuTitle')} <span class="text-small" id="gui-annotations-io-tissue-name">${this.t('annotations.export.forSlide', { slide: this.activeTissue })}</span></h3><br>
<span class="text-small">${this.t('annotations.export.description')}</span>
<div id="annotations-shared-head"></div><div id="available-annotations"></div>
<br>
<h4 class="f3-light header-sep">${this.t('annotations.export.fileSection')}</h4><br>
<div>${this.exportOptions.availableFormats.map((o) => this.getIOFormatRadioButton(o)).join('')}</div>
<div id="annotation-convertor-options"></div>
<div id="export-annotations-scope" class="mt-2">
  <span class="text-small mr-2">${this.t('annotations.export.scopeLabel')}</span>
  ${['all', 'selected'].map((s) => this.getExportScopeRadioButton(s)).join('')}
</div>
<br>
${UIComponents.Elements.checkBox({ label: this.t('annotations.export.replaceOnImport'), onchange: this.THIS + ".setOption('importReplace', !!this.checked)", default: this.getOption('importReplace', true) })}
<br><br>
<div id="annotations-local-export-panel">
  <button id="importAnnotation" onclick="this.nextElementSibling.click();return false;" class="btn"></button>
  <input type='file' style="visibility:hidden; width: 0; height: 0;" onchange="${this.THIS}.importFromFile(event);$(this).val('');" />
  &emsp;&emsp;
  <button id="downloadPreset" onclick="${this.THIS}.exportToFile(false, true);return false;" class="btn">${this.t('annotations.export.downloadPresets')}</button>&nbsp;
  <button id="downloadAnnotation" onclick="${this.THIS}.exportToFile(true, true);return false;" class="btn">${this.t('annotations.export.downloadAnnotations')}</button>&nbsp;
</div>
<h4 class="f3-light header-sep">${this.t('annotations.comments.title')}</h4><br>
${UIComponents.Elements.checkBox({ label: this.t('annotations.comments.enable'), onchange: this.THIS + '.enableComments(!!this.checked)', default: this._commentsEnabled })}
${UIComponents.Elements.checkBox({ label: this.t('annotations.comments.autoOpen'), onchange: this.THIS + '.commentsDefaultOpen(!!this.checked)', default: this._commentsDefaultOpened })}
<div class="flex gap-2 justify-between">
  <span>${this.t('annotations.comments.rememberState')}</span>
  ${UIComponents.Elements.select({
                default: this._commentsClosedMethod,
                options: {
                    none: this.t('annotations.comments.rememberOptions.none'),
                    global: this.t('annotations.comments.rememberOptions.global'),
                    individual: this.t('annotations.comments.rememberOptions.individual')
                },
                changed: this.THIS + '.switchCommentsClosedMethod(value)'
            })}
</div>`);

        this.annotationsMenuBuilder = new UIComponents.Containers.RowPanel('available-annotations');
        this.updateSelectedFormat(this.exportOptions.format);
        this.updatePresetsHTML();

        this.context.addHandler('author-annotation-styling-toggle', (e) => this._toggleStrokeStyling(e.enable));
        this.context.addHandler('comments-control-clicked', () => this.commentsToggleWindow());
        this.context.addHandler('annotation-updated-comment', () => this._renderComments());
        this._toggleStrokeStyling(this.context.strokeStyling);
    },

    switchMenuList(type, viewerOrId = undefined) {
        const viewerId = this._resolveViewerId(viewerOrId);
        const state = this._getViewerUI(viewerId);
        if (!state) return;

        state.currentTab = type;
        state.presetTabButton.classList.toggle('btn-active', type === 'preset');
        state.annotationTabButton.classList.toggle('btn-active', type === 'annot');
        state.authorTabButton.classList.toggle('btn-active', type === 'authors');

        state.presetList.classList.toggle('hidden', type !== 'preset');
        state.annotationList.classList.toggle('hidden', type !== 'annot');
        state.authorList.classList.toggle('hidden', type !== 'authors');

        if (type === 'preset') this._renderPresetList(viewerId);
        else if (type === 'authors') this._populateAuthorsList(viewerId);
        else state.boardPanel?.mount();
    },

    _renderPresetList(viewerOrId = undefined) {
        const state = this._getViewerUI(viewerOrId);
        if (!state?.presetInner) return;

        const nodes = [];
        let pushed = false;
        this.context.presets.foreach((preset) => {
            const containerCss = this.isUnpreferredPreset(preset.presetID) ? 'opacity-50' : '';
            const category = preset.meta?.category?.value || this.t('annotations.viewerMenu.unknownPreset');
            nodes.push(button({
                    type: 'button',
                    class: `btn btn-ghost btn-sm justify-start w-full ${containerCss}`.trim(),
                    onclick: () => this._clickPresetSelect(true, preset.presetID),
                    oncontextmenu: (e) => {
                        e.preventDefault();
                        this._clickPresetSelect(false, preset.presetID);
                        return false;
                    }
                },
                span({ class: `fa-auto ${preset.objectFactory.getIcon()} mr-2`, style: `color:${preset.color};` }),
                span({ class: 'truncate' }, category)
            ));
            pushed = true;
        });

        if (!pushed) {
            nodes.push(div({ class: 'text-sm opacity-70' },
                this.t('annotations.viewerMenu.noPresetsPrefix'), ' ',
                button({ type: 'button', class: 'link link-primary', onclick: () => this.showPresets() }, this.t('annotations.viewerMenu.createPresetLink')),
                '.'
            ));
        }

        state.presetInner.replaceChildren(...nodes);
    },

    _toggleEnabled(btnElement) {
        this.context.enableAnnotations(this.context.disabledInteraction);
        this._updateViewerControls();

        const toolBar =
            document.getElementById('annotations-tool-bar-content') ||
            document.getElementById('annotations-tool-bar');

        if (toolBar) {
            const enabled = !this.context.disabledInteraction;
            toolBar.style.pointerEvents = enabled ? 'auto' : 'none';
            toolBar.style.opacity = enabled ? '1' : '0.5';
            toolBar.setAttribute('aria-disabled', enabled ? 'false' : 'true');
            toolBar.classList.toggle('disabled', !enabled);
        }
    },

    _populateAuthorsList(viewerOrId = undefined) {
        const state = this._getViewerUI(viewerOrId);
        if (!state?.authorInner) return;

        const viewerId = this._resolveViewerId(viewerOrId);
        const fabric = this.context.getFabric(viewerId);
        if (!fabric) return;

        const map = new Map();
        for (const object of fabric.canvas?.getObjects?.() || []) {
            if (!fabric.isAnnotation?.(object)) continue;
            const author = object.author || this.t('annotations.viewerMenu.unknownAuthor');
            map.set(author, (map.get(author) || 0) + 1);
        }

        const rows = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, count]) =>
            div({ class: 'flex items-center justify-between py-1 px-2 rounded hover:bg-base-200' },
                span({ class: 'truncate mr-2' }, name),
                span({ class: 'badge badge-ghost badge-sm' }, String(count))
            )
        );

        if (!rows.length) rows.push(div({ class: 'text-sm opacity-70 px-2' }, this.t('annotations.viewerMenu.noAuthors')));
        state.authorInner.replaceChildren(...rows);
    },

    _refreshAllBoardPanels() {
        for (const viewer of VIEWER_MANAGER.viewers || []) {
            this._getViewerUI(viewer.uniqueId)?.boardPanel?.requestRender();
        }
    },

    _refreshAllPresetLists() {
        for (const viewer of VIEWER_MANAGER.viewers || []) this._renderPresetList(viewer.uniqueId);
    },

    _refreshAllAuthorLists() {
        for (const viewer of VIEWER_MANAGER.viewers || []) this._populateAuthorsList(viewer.uniqueId);
    },

    _updateViewerControls(viewerOrId = undefined) {
        const apply = (state) => {
            if (!state) return;
            state.outlineButton?.classList.toggle('btn-active', !!this.context.getAnnotationCommonVisualProperty('modeOutline'));
            state.edgeButton?.classList.toggle('btn-active', !!this.getOption('edgeCursorNavigate', true));
            if (state.borderInput) state.borderInput.value = String(this.context.getAnnotationCommonVisualProperty('originalStrokeWidth'));
            if (state.opacityInput) state.opacityInput.value = String(this.context.getAnnotationCommonVisualProperty('opacity'));
        };

        if (viewerOrId) return apply(this._getViewerUI(viewerOrId));
        for (const viewer of VIEWER_MANAGER.viewers || []) apply(this._getViewerUI(viewer.uniqueId));
    },

    getExportScopeRadioButton(scope) {
        const id = `export-scope-${scope}-radio`;
        const label = scope === 'all' ? this.t('annotations.export.scopeOptions.all') : this.t('annotations.export.scopeOptions.selected');
        const checked = this.exportOptions.scope === scope ? 'checked' : '';
        return `
      <div class="d-inline-block p-2">
        <input type="radio" id="${id}" class="d-none switch" ${checked} name="annotation-scope-switch">
        <label for="${id}" class="position-relative format-selector" onclick="${this.THIS}.setExportScope('${scope}');">
          <span class="btn">${label}</span>
        </label>
      </div>`;
    },

    getIOFormatRadioButton(format) {
        const selected = format === this.exportOptions.format ? 'checked' : '';
        const convertor = OSDAnnotations.Convertor.get(format);
        return `<div class="d-inline-block p-2"><input type="radio" id="${format}-export-format" class="hidden switch" ${selected} name="annotation-format-switch">
<label for="${format}-export-format" class="position-relative format-selector" title="${convertor.description || ''}" onclick="${this.THIS}.updateSelectedFormat('${format}');"><span style="font-size: smaller">${convertor.title}</span><br>
<span class="show-hint d-inline-block" data-hint="${this.t('annotations.export.formatHint')}"><span class="btn">${format}</span></span></label></div>`;
    },

    updateSelectedFormat(format) {
        const convertor = OSDAnnotations.Convertor.get(format);
        document.getElementById('downloadAnnotation').style.visibility = convertor.exportsObjects ? 'visible' : 'hidden';
        document.getElementById('downloadPreset').style.visibility = convertor.exportsPresets ? 'visible' : 'hidden';
        const scopeEl = document.getElementById('export-annotations-scope');
        if (scopeEl) scopeEl.style.display = convertor.exportsObjects ? 'block' : 'none';

        document.getElementById('importAnnotation').innerHTML = this.t('annotations.export.importFileButton', { format });
        this.exportOptions.format = format;
        this.setCacheOption('defaultIOFormat', format);
        $('#annotation-convertor-options').html(
            Object.values(convertor.options).map((option) => UIComponents.Elements[option.type]?.(option)).join('<br>')
        );
    }
};
