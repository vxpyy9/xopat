const { div, button, input, span, h3, h4, label, select, option, section, header, i } = globalThis.van.tags;

export const createAnnotationSettingsMenu = (plugin) => {
    // Reactive state for the UI
    const selectedFormat = van.state(plugin.exportOptions.format);
    const selectedScope = van.state(plugin.exportOptions.scope || 'all');
    const importReplace = van.state(plugin.getOption('importReplace', true));

    // Derived state for the current convertor
    const getConvertor = () => OSDAnnotations.Convertor.get(selectedFormat.val);

    return div({ class: "p-4 space-y-6 flex flex-col h-full overflow-y-auto" },
        // --- Header ---
        header({ class: "border-b border-base-300 pb-2" },
            h3({ class: "text-lg font-bold flex items-center gap-2" },
                i({ class: "fa-solid fa-file-export opacity-70" }),
                plugin.t('annotations.export.menuTitle')
            ),
            div({ class: "text-xs opacity-60 italic" },
                plugin.t('annotations.export.forSlide', { slide: plugin.activeTissue })
            )
        ),

        // --- Format Selection ---
        section({ class: "space-y-3" },
            h4({ class: "text-sm font-bold uppercase opacity-50 tracking-wider" },
                plugin.t('annotations.export.fileSection')
            ),
            div({ class: "grid grid-cols-2 gap-2" },
                plugin.exportOptions.availableFormats.map(format => {
                    const conv = OSDAnnotations.Convertor.get(format);
                    return button({
                        class: () => `btn btn-sm ${selectedFormat.val === format ? 'btn-primary' : 'btn-outline'}`,
                        onclick: () => {
                            selectedFormat.val = format;
                            plugin.updateSelectedFormat(format);
                        },
                        title: conv.description || ''
                    }, format);
                })
            ),
            // Dynamic Convertor Options
            div({
                class: "bg-base-200 p-2 rounded-lg text-sm",
                innerHTML: () => Object.values(getConvertor().options)
                    .map(opt => UIComponents.Elements[opt.type]?.(opt) || '').join('')
            })
        ),

        // --- IO Controls ---
        section({ class: "card bg-base-100 border border-base-300 shadow-sm" },
            div({ class: "card-body p-4 gap-4" },
                // Scope (All vs Selected)
                div({ class: () => `form-control ${getConvertor().exportsObjects ? '' : 'hidden'}` },
                    label({ class: "label" }, span({ class: "label-text font-semibold" }, plugin.t('annotations.export.scopeLabel'))),
                    div({ class: "join w-full" },
                        ['all', 'selected'].map(s => button({
                            class: () => `join-item btn btn-xs flex-1 ${selectedScope.val === s ? 'btn-active' : ''}`,
                            onclick: () => {
                                selectedScope.val = s;
                                plugin.setExportScope(s);
                            }
                        }, plugin.t(`annotations.export.scopeOptions.${s}`)))
                    )
                ),

                // Replace Checkbox
                label({ class: "label cursor-pointer justify-start gap-3 bg-base-200 rounded-lg px-3" },
                    input({
                        type: "checkbox", class: "checkbox checkbox-sm checkbox-primary",
                        checked: importReplace,
                        onchange: (e) => {
                            importReplace.val = e.target.checked;
                            plugin.setOption('importReplace', e.target.checked);
                        }
                    }),
                    span({ class: "label-text" }, plugin.t('annotations.export.replaceOnImport'))
                ),

                // Action Buttons
                div({ class: "flex flex-col gap-2 pt-2" },
                    div({ class: "flex gap-2" },
                        button({
                            class: "btn btn-primary flex-1",
                            onclick: (e) => e.target.nextElementSibling.click()
                        }, plugin.t('annotations.export.importFileButton', { format: selectedFormat.val })),
                        input({
                            type: 'file', class: "hidden",
                            onchange: (e) => { plugin.importFromFile(e); e.target.value = ''; }
                        })
                    ),
                    div({ class: "grid grid-cols-2 gap-2" },
                        button({
                            class: () => `btn btn-outline btn-sm ${getConvertor().exportsPresets ? '' : 'btn-disabled'}`,
                            onclick: () => plugin.exportToFile(false, true)
                        }, plugin.t('annotations.export.downloadPresets')),
                        button({
                            class: () => `btn btn-outline btn-sm ${getConvertor().exportsObjects ? '' : 'btn-disabled'}`,
                            onclick: () => plugin.exportToFile(true, true)
                        }, plugin.t('annotations.export.downloadAnnotations'))
                    )
                )
            )
        ),

        // --- Comments Section ---
        section({ class: "space-y-3 pt-2" },
            h4({ class: "text-sm font-bold uppercase opacity-50 tracking-wider" }, plugin.t('annotations.comments.title')),
            label({ class: "label cursor-pointer" },
                span({ class: "label-text" }, plugin.t('annotations.comments.enable')),
                input({
                    type: "checkbox", class: "toggle toggle-primary toggle-sm",
                    checked: plugin._commentsEnabled,
                    onchange: (e) => plugin.enableComments(e.target.checked)
                })
            ),
            div({ class: "form-control" },
                label({ class: "label" }, span({ class: "label-text text-xs" }, plugin.t('annotations.comments.rememberState'))),
                select({
                        class: "select select-bordered select-sm",
                        onchange: (e) => plugin.switchCommentsClosedMethod(e.target.value)
                    },
                    ['none', 'global', 'individual'].map(m => option({
                        value: m,
                        selected: plugin._commentsClosedMethod === m
                    }, plugin.t(`annotations.comments.rememberOptions.${m}`)))
                )
            )
        )
    );
};