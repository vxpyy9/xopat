import type {ScriptApiInvocationContext, ScriptApiObject, ScriptApiMetadata, HostScriptContext} from "./abstract-types";

export abstract class XOpatScriptingApi implements ScriptApiObject {
    static readonly ScriptApiMetadata?: ScriptApiMetadata;

    readonly namespace: string;
    readonly name: string;
    readonly description: string;
    protected _invocationContext?: ScriptApiInvocationContext;

    protected constructor(namespace: string, name: string, description: string) {
        this.namespace = namespace;
        this.name = name;
        this.description = description;
    }

    bindInvocationContext(context: ScriptApiInvocationContext): this {
        const bound = Object.create(Object.getPrototypeOf(this)) as this;
        Object.assign(bound, this);
        bound._invocationContext = context;
        return bound;
    }

    protected get scriptingContext(): HostScriptContext {
        const context = this._invocationContext?.scriptingContext;
        if (!context) {
            throw new Error(`Script API namespace '${this.namespace}' was called without a scripting context.`);
        }
        return context;
    }

    protected get activeViewer(): OpenSeadragon.Viewer {
        const viewers = VIEWER_MANAGER?.viewers || [];

        if (!viewers.length) {
            throw new Error("No viewer is available. Open a slide first.");
        }

        const selectedContextId =
            this.scriptingContext.getActiveViewerContextId?.() ??
            this.scriptingContext.activeViewerContextId ??
            this.scriptingContext.id;

        if (selectedContextId) {
            const boundViewer = viewers.find(
                (viewer: OpenSeadragon.Viewer) => viewer.uniqueId === selectedContextId
            );
            if (boundViewer) {
                return boundViewer;
            }

            throw new Error(
                `The current script context is bound to viewer '${selectedContextId}', but that viewer is not available.`
            );
        }

        if (viewers.length === 1) {
            return viewers[0];
        }

        throw new Error(
            "No viewer is selected for this script context. First call application.getGlobalInfo() and then application.setActiveViewer(contextId)."
        );
    }
}