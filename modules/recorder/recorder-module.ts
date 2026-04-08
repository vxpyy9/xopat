/// <reference path="../../src/types/globals.d.ts" />
/// <reference path="../../src/types/loader.d.ts" />
/// <reference path="./recorder.d.ts" />

type RecorderManagedViewer = OpenSeadragon.Viewer & {
    tools?: RecorderViewerTools;
    bridge?: RecorderViewerBridge;
};

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
    return $.extend(true, {}, value) as T;
}

class Recorder extends XOpatModuleSingleton implements RecorderModule {
    private readonly _snapshotsState: RecorderState;

    constructor() {
        super();
        void this.initPostIO();

        OpenSeadragon.Recorder.__exportViewer = async (viewerId: UniqueViewerId) => {
            try {
                const viewer = VIEWER_MANAGER.getViewer(viewerId);
                const data = await this.exportViewerData(viewer, "", viewerId);
                UTILITIES.downloadAsFile(`recorder-${viewerId}.json`, data);
            } catch (error) {
                console.error(error);
                Dialogs.show("Failed to export recorder state.", 2500, Dialogs.MSG_ERR);
            }
        };

        this._snapshotsState = {
            idx: 0,
            steps: [],
            currentStep: null,
            currentPlayback: null,
            playing: false,
            captureVisualization: false,
            captureViewport: true,
            captureScreen: false,
            playbackAnnotationFilters: null,
        };
    }

    async exportData(_key: string): Promise<string> {
        return JSON.stringify(this._snapshotsState.steps);
    }

    async importData(_key: string, data: string): Promise<void> {
        this._importJSON(data);
    }

    create(
        viewerId: UniqueViewerId,
        delay = 0,
        duration = 0.5,
        transition = 1.6,
        atIndex?: number,
    ): RecorderSnapshotStep | false {
        const state = this._snapshotsState;
        if (state.playing) return false;

        const viewer = this._resolveViewer(viewerId);
        if (!viewer?.viewport) {
            console.warn("Recorder.create() skipped: no viewer is available for recording.", { viewerId });
            return false;
        }

        const step: RecorderSnapshotStep = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "keyframe",
            rotation: state.captureViewport ? viewer.viewport.getRotation() : undefined,
            zoomLevel: state.captureViewport ? viewer.viewport.getZoom() : undefined,
            point: state.captureViewport ? viewer.viewport.getCenter() : undefined,
            bounds: state.captureViewport ? viewer.viewport.getBounds() : undefined,
            preferSameZoom: true,
            delay,
            duration,
            transition,
            visualization: this._getVisualizationSnapshot(viewer, state.captureVisualization),
            annotationFilters: this._getAnnotationFiltersSnapshot(),
            viewerId: viewer.uniqueId || viewerId,
            screenShot: state.captureScreen ? viewer.tools?.screenshot(true, { x: 120, y: 120 }) : undefined,
        };

        this._add(step, atIndex);
        return step;
    }

    createNavigation(
        viewerId: UniqueViewerId,
        samples: RecorderNavigationSample[],
        delay = 0,
        duration = 0.5,
        transition = 1.6,
        atIndex?: number,
    ): RecorderSnapshotStep | false {
        const state = this._snapshotsState;
        if (state.playing) return false;

        const viewer = this._resolveViewer(viewerId);
        if (!viewer?.viewport || samples.length < 2) {
            console.warn("Recorder.createNavigation() skipped: not enough navigation samples.", { viewerId, sampleCount: samples.length });
            return false;
        }

        const normalizedSamples = this._normalizeNavigationSamples(samples);
        const lastSample = normalizedSamples[normalizedSamples.length - 1];
        if (!lastSample) return false;
        const recordedDuration = Math.max(0.1, (lastSample.at || 0) / 1000);

        const step: RecorderSnapshotStep = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "navigation",
            delay,
            duration: recordedDuration,
            transition,
            preferSameZoom: true,
            viewerId: viewer.uniqueId || viewerId,
            rotation: lastSample.rotation,
            zoomLevel: lastSample.zoomLevel,
            point: lastSample.point,
            bounds: lastSample.bounds,
            navigation: { samples: normalizedSamples },
            visualization: this._getVisualizationSnapshot(viewer, state.captureVisualization),
            annotationFilters: this._getAnnotationFiltersSnapshot(),
        };

        this._add(step, atIndex);
        return step;
    }

    remove(index?: number): void {
        const state = this._snapshotsState;
        if (state.playing) return;

        const resolvedIndex = index ?? state.idx;
        const step = state.steps[resolvedIndex];
        if (!step) return;

        state.steps.splice(resolvedIndex, 1);
        state.idx = state.steps.length ? state.idx % state.steps.length : 0;
        this.raiseEvent("remove", { viewerId: step.viewerId, index: resolvedIndex, step });
    }

    getSteps(): RecorderSnapshotStep[] {
        return this._snapshotsState.steps.filter((step) => this._isValidStep(step));
    }

    getStep(index: number): RecorderSnapshotStep | undefined {
        return this._snapshotsState.steps[index];
    }

    snapshotCount(): number {
        return this._snapshotsState.steps.length;
    }

    currentStep(): RecorderSnapshotStep | undefined {
        return this._snapshotsState.steps[this._snapshotsState.idx];
    }

    currentStepIndex(): number {
        return this._snapshotsState.idx;
    }

    isPlaying(): boolean {
        return this._snapshotsState.playing;
    }

    play(): void {
        const state = this._snapshotsState;
        if (state.playing) return;
        if (state.idx >= state.steps.length) {
            state.idx = Math.max(0, state.steps.length - 1);
        }

        state.playbackAnnotationFilters = this._getAnnotationFiltersSnapshot();
        state.playing = true;
        this.raiseEvent("play", {});
        this.playStep(state.idx);
    }

    previous(): void {
        const state = this._snapshotsState;
        if (state.playing) {
            if (!state.steps.length) return;
            this.playStep(((state.idx - 1) % state.steps.length + state.steps.length) % state.steps.length, true, state.idx);
            return;
        }
        void this.goToIndex(state.idx - 1);
    }

    next(): void {
        const state = this._snapshotsState;
        if (state.playing) {
            if (!state.steps.length) return;
            this.playStep((state.idx + 1) % state.steps.length, true, state.idx);
            return;
        }
        void this.goToIndex(state.idx + 1);
    }

    playFromIndex(index: number): void {
        const state = this._snapshotsState;
        if (state.playing) return;
        state.idx = index;
        this.play();
    }

    stop(): void {
        const state = this._snapshotsState;
        if (!state.playing) return;

        state.currentStep?.cancel();
        state.currentStep = null;
        state.currentPlayback?.cancel();
        state.currentPlayback = null;
        state.playing = false;
        if (state.playbackAnnotationFilters) {
            this._setAnnotationFilters(state.playbackAnnotationFilters);
        } else {
            this._clearAnnotationFilters();
        }
        state.playbackAnnotationFilters = null;
        this.raiseEvent("stop", {});
    }

    goToIndex(atIndex: number): RecorderSnapshotStep | undefined {
        const state = this._snapshotsState;
        if (state.playing || !state.steps.length) return undefined;

        state.idx = ((atIndex % state.steps.length) + state.steps.length) % state.steps.length;
        return this._jumpAt(state.idx);
    }

    set capturesVisualization(value: boolean) {
        this._snapshotsState.captureVisualization = !!value;
    }

    get capturesVisualization(): boolean {
        return !!this._snapshotsState.captureVisualization;
    }

    set capturesViewport(value: boolean) {
        this._snapshotsState.captureViewport = !!value;
    }

    get capturesViewport(): boolean {
        return !!this._snapshotsState.captureViewport;
    }

    set capturesScreen(value: boolean) {
        this._snapshotsState.captureScreen = !!value;
    }

    get capturesScreen(): boolean {
        return !!this._snapshotsState.captureScreen;
    }

    setCapturesVisualization(value: boolean): void {
        this.capturesVisualization = value;
    }

    setCapturesViewport(value: boolean): void {
        this.capturesViewport = value;
    }

    setCapturesScreen(value: boolean): void {
        this.capturesScreen = value;
    }

    exportJSON(serialize = true): string | RecorderSnapshotStep[] {
        const steps = [...this._snapshotsState.steps];
        return serialize ? JSON.stringify(steps) : steps;
    }

    importJSON(json: string | RecorderSnapshotStep[]): RecorderSnapshotStep[] {
        this._importJSON(json);
        return this.getSteps();
    }

    stepCapturesVisualization(step: RecorderSnapshotStep): boolean {
        return !!step.visualization?.cache;
    }

    stepCapturesViewport(step: RecorderSnapshotStep): boolean {
        return !!step.point && typeof step.zoomLevel === "number" && !Number.isNaN(step.zoomLevel);
    }

    stepCapturesNavigation(step: RecorderSnapshotStep): boolean {
        return !!step.navigation?.samples?.length;
    }

    sortWithIdList(ids: string[], removeMissing = false): void {
        const state = this._snapshotsState;
        if (removeMissing) {
            state.steps = state.steps.filter((step) => ids.includes(step.id));
        }

        state.steps.sort((left, right) => {
            const leftIndex = ids.indexOf(left.id);
            const rightIndex = ids.indexOf(right.id);
            if (leftIndex < 0) return 1;
            if (rightIndex < 0) return -1;
            return leftIndex - rightIndex;
        });
    }

    private _importJSON(json: string | RecorderSnapshotStep[]): void {
        const state = this._snapshotsState;
        const parsed = typeof json === "string" ? JSON.parse(json) : json;

        state.idx = 0;
        state.steps = [];
        state.currentStep = null;
        state.currentPlayback = null;
        state.playbackAnnotationFilters = null;

        if (Array.isArray(parsed)) {
            for (const item of parsed) {
                if (!item) continue;

                const step: RecorderSnapshotStep = {
                    ...item,
                    kind: item.kind || (item.navigation?.samples?.length ? "navigation" : "keyframe"),
                    rotation: typeof item.rotation === "number" ? item.rotation : undefined,
                    point: item.point ? new OpenSeadragon.Point(item.point.x, item.point.y) : undefined,
                    bounds: item.bounds
                        ? new OpenSeadragon.Rect(item.bounds.x, item.bounds.y, item.bounds.width, item.bounds.height)
                        : undefined,
                    navigation: item.navigation?.samples?.length ? {
                        samples: item.navigation.samples.map((sample) => ({
                            ...sample,
                            rotation: typeof sample.rotation === "number" ? sample.rotation : undefined,
                            point: sample.point ? new OpenSeadragon.Point(sample.point.x, sample.point.y) : undefined,
                            bounds: sample.bounds
                                ? new OpenSeadragon.Rect(sample.bounds.x, sample.bounds.y, sample.bounds.width, sample.bounds.height)
                                : undefined,
                        })),
                    } : undefined,
                    annotationFilters: Array.isArray(item.annotationFilters)
                        ? item.annotationFilters.map((filter) => this._cloneAnnotationFilter(filter))
                        : undefined,
                };
                this._add(step);
            }
        }

        state.idx = 0;
    }

    private _resolveViewer(viewerId?: UniqueViewerId): RecorderManagedViewer | undefined {
        return (
            VIEWER_MANAGER.getViewer(viewerId, false) ||
            VIEWER_MANAGER.get?.() ||
            VIEWER_MANAGER.viewers?.[0]
        ) as RecorderManagedViewer | undefined;
    }

    private _isValidStep(indexOrStep: number | RecorderSnapshotStep | undefined): boolean {
        const step = typeof indexOrStep === "number"
            ? this._snapshotsState.steps[indexOrStep]
            : indexOrStep;
        return !!step?.viewerId && !!VIEWER_MANAGER.getViewer(step.viewerId);
    }

    private playStep(index: number, jumps = false, fromIndex?: number): void {
        const state = this._snapshotsState;
        state.currentStep?.cancel();
        state.currentPlayback?.cancel();
        state.currentStep = null;
        state.currentPlayback = null;

        while (state.steps.length > index && !state.steps[index]) {
            index += 1;
        }

        if (state.steps.length <= index) {
            state.currentStep = null;
            this.stop();
            return;
        }

        const current = state.steps[index];
        if (!current) {
            this.stop();
            return;
        }

        let previousIndex = typeof fromIndex === "number" ? fromIndex : index - 1;
        while (previousIndex > 0 && !this._isValidStep(previousIndex)) {
            previousIndex -= 1;
        }

        const delayMs = jumps ? 0 : current.delay * 1000;
        state.currentStep = this._setDelayed(delayMs, index);
        state.currentStep.promise.then((atIndex) => {
            if (!state.playing) return;

            this._jumpAt(atIndex, previousIndex >= 0 ? previousIndex : undefined);
            state.idx = atIndex;

            const nextIndex = atIndex + 1;
            const durationMs = Math.max(0, current.duration * 1000);
            if (nextIndex >= state.steps.length) {
                state.currentStep = this._setDelayed(durationMs, nextIndex);
                state.currentStep.promise.then(() => this.stop()).catch(() => undefined);
                return;
            }

            state.currentStep = this._setDelayed(durationMs, nextIndex);
            state.currentStep.promise.then((resolvedNextIndex) => {
                if (!state.playing) return;
                this.playStep(resolvedNextIndex, false, atIndex);
            }).catch(() => undefined);
        }).catch(() => undefined);
    }

    private _getVisualizationSnapshot(
        viewer: RecorderManagedViewer,
        captureVisualization: boolean,
    ): RecorderVisualizationSnapshot | undefined {
        const bridge = viewer.bridge;
        if (!captureVisualization || !bridge) return undefined;

        const visualization = bridge.visualization();
        const shadersCache: Record<string, Record<string, unknown>> = {};

        for (const key of visualization.order) {
            const shader = visualization.shaders[key];
            if (shader?.rendering) {
                shadersCache[key] = cloneRecord(shader.cache);
            }
        }

        return {
            index: bridge.currentVisualizationIndex(),
            cache: shadersCache,
            order: [...visualization.order],
        };
    }

    private _getAnnotationsModule(): {
        getAnnotationFilters?: () => RecorderAnnotationFilter[];
        setAnnotationFilters?: (filters: RecorderAnnotationFilter[]) => void;
        clearAnnotationFilters?: () => void;
    } | null {
        try {
            return (window as Window & {
                OSDAnnotations?: {
                    instance(): {
                        getAnnotationFilters?: () => RecorderAnnotationFilter[];
                        setAnnotationFilters?: (filters: RecorderAnnotationFilter[]) => void;
                        clearAnnotationFilters?: () => void;
                    };
                };
            }).OSDAnnotations?.instance?.() || null;
        } catch (_error) {
            return null;
        }
    }

    private _getAnnotationFiltersSnapshot(): RecorderAnnotationFilter[] {
        const annotations = this._getAnnotationsModule();
        const filters = annotations?.getAnnotationFilters?.();
        if (!Array.isArray(filters)) return [];
        return filters.map((filter) => this._cloneAnnotationFilter(filter));
    }

    private _setAnnotationFilters(filters: RecorderAnnotationFilter[]): void {
        const annotations = this._getAnnotationsModule();
        if (!annotations?.setAnnotationFilters) return;
        annotations.setAnnotationFilters(filters.map((filter) => this._cloneAnnotationFilter(filter)));
    }

    private _clearAnnotationFilters(): void {
        const annotations = this._getAnnotationsModule();
        if (annotations?.clearAnnotationFilters) {
            annotations.clearAnnotationFilters();
            return;
        }
        annotations?.setAnnotationFilters?.([]);
    }

    private _cloneAnnotationFilter(filter: RecorderAnnotationFilter): RecorderAnnotationFilter {
        return {
            id: filter.id,
            type: filter.type,
            values: Array.isArray(filter.values) ? [...filter.values] : undefined,
            rect: filter.rect
                ? {
                    x: filter.rect.x,
                    y: filter.rect.y,
                    width: filter.rect.width,
                    height: filter.rect.height,
                }
                : undefined,
        };
    }

    private _setDelayed(milliseconds: number, index: number): RecorderDelayHandle {
        if (milliseconds <= 0) {
            return { promise: Promise.resolve(index), cancel() {} };
        }

        let timeoutId: number | undefined;
        const promise = new Promise<number>((resolve) => {
            timeoutId = window.setTimeout(() => resolve(index), milliseconds);
        });

        return {
            promise,
            cancel() {
                if (timeoutId !== undefined) {
                    window.clearTimeout(timeoutId);
                }
            },
        };
    }

    private _add(step: RecorderSnapshotStep, index?: number): void {
        if (!this._isValidStep(step)) return;

        const state = this._snapshotsState;
        let resolvedIndex = typeof index === "number" ? index : state.steps.length;

        if (resolvedIndex >= 0 && resolvedIndex < state.steps.length) {
            state.steps.splice(resolvedIndex, 0, step);
        } else {
            resolvedIndex = state.steps.length;
            state.steps.push(step);
        }

        this.raiseEvent("create", { viewerId: step.viewerId, index: resolvedIndex, step });
    }

    private _jumpAt(index: number, fromIndex?: number): RecorderSnapshotStep | undefined {
        const state = this._snapshotsState;
        const step = state.steps[index];
        if (!step || state.steps.length <= index) return undefined;

        const viewer = VIEWER_MANAGER.getViewer(step.viewerId) as RecorderManagedViewer | undefined;
        if (!viewer) return undefined;

        const capturesNavigation = this.stepCapturesNavigation(step);
        const capturesViewport = this.stepCapturesViewport(step);
        if (step.visualization) {
            this._setVisualization(viewer, step, capturesViewport || capturesNavigation ? step.duration : 0);
        }

        if (capturesNavigation) {
            const immediate = !state.playing;
            state.currentPlayback = this._playNavigation(viewer, step, immediate);
        } else if (capturesViewport) {
            if (typeof step.rotation === "number" && !Number.isNaN(step.rotation)) {
                viewer.viewport.setRotation(step.rotation, true);
            }
            viewer.tools?.focus(step);
        } else {
            viewer.bridge?.redraw();
        }

        if (state.playing) {
            this._setAnnotationFilters(step.annotationFilters || []);
        }

        this.raiseEvent("enter", {
            index,
            prevIndex: typeof fromIndex === "number" && !Number.isNaN(fromIndex) ? fromIndex : undefined,
            prevStep: typeof fromIndex === "number" && !Number.isNaN(fromIndex) ? state.steps[fromIndex] : undefined,
            step,
        });
        return step;
    }

    private _setVisualization(viewer: RecorderManagedViewer, step: RecorderSnapshotStep, duration: number): void {
        const bridge = viewer.bridge;
        const target = step.visualization;
        if (!bridge || !target) return;

        const currentIndex = bridge.currentVisualizationIndex();
        const currentVisualization = bridge.visualization(target.index);
        let needsRefresh = !this._equalOrder(currentVisualization.order, target.order);

        for (const [key, shaderSetup] of Object.entries(currentVisualization.shaders)) {
            const willBeVisible = Object.prototype.hasOwnProperty.call(target.cache, key);
            if (willBeVisible !== shaderSetup.visible) {
                needsRefresh = true;
            }

            shaderSetup.visible = willBeVisible;
            if (!shaderSetup.visible) continue;

            const cachedState = target.cache[key];
            if (!cachedState) continue;

            if (!needsRefresh && !this._equalCache(shaderSetup.cache, cachedState)) {
                needsRefresh = true;
            }
            if (needsRefresh) {
                shaderSetup.cache = cloneRecord(cachedState);
            }
        }

        if (currentIndex !== target.index) {
            currentVisualization.order = [...target.order];
            bridge.switchVisualization(target.index);
            return;
        }

        if (needsRefresh) {
            bridge.webGLEngine?.rebuildVisualization(target.order);
            bridge.redraw(duration * 900);
        }
    }

    private _normalizeNavigationSamples(samples: RecorderNavigationSample[]): RecorderNavigationSample[] {
        if (!samples.length) return [];

        const firstAt = samples[0].at || 0;
        const shifted = samples.map((sample) => ({
            ...sample,
            at: Math.max(0, sample.at - firstAt),
            rotation: typeof sample.rotation === "number" ? sample.rotation : undefined,
            point: sample.point ? new OpenSeadragon.Point(sample.point.x, sample.point.y) : undefined,
            bounds: sample.bounds
                ? new OpenSeadragon.Rect(sample.bounds.x, sample.bounds.y, sample.bounds.width, sample.bounds.height)
                : undefined,
        }));

        const duration = shifted[shifted.length - 1]?.at || 0;
        if (duration <= 0) {
            return shifted.map((sample, index) => ({ ...sample, at: index }));
        }

        return shifted;
    }

    private _playNavigation(viewer: RecorderManagedViewer, step: RecorderSnapshotStep, immediate: boolean): RecorderDelayHandle | null {
        const samples = step.navigation?.samples;
        if (!samples?.length) return null;
        const recordedDurationMs = samples[samples.length - 1]?.at || 0;

        if (immediate || step.duration <= 0 || recordedDurationMs <= 0) {
            this._applyNavigationSample(viewer, samples[samples.length - 1]);
            return { promise: Promise.resolve(-1), cancel() {} };
        }

        const startedAt = performance.now();
        const targetDurationMs = Math.max(1, step.duration * 1000);
        let frameId = 0;
        let cancelled = false;

        const promise = new Promise<number>((resolve) => {
            const tick = () => {
                if (cancelled) {
                    resolve(-1);
                    return;
                }

                const elapsedMs = performance.now() - startedAt;
                const playbackTimeMs = Math.min(recordedDurationMs, (elapsedMs / targetDurationMs) * recordedDurationMs);
                this._applyNavigationSample(viewer, this._interpolateNavigationSample(samples, playbackTimeMs));

                if (elapsedMs >= targetDurationMs) {
                    this._applyNavigationSample(viewer, samples[samples.length - 1]);
                    resolve(-1);
                    return;
                }
                frameId = window.requestAnimationFrame(tick);
            };

            frameId = window.requestAnimationFrame(tick);
        });

        return {
            promise,
            cancel() {
                cancelled = true;
                if (frameId) window.cancelAnimationFrame(frameId);
            },
        };
    }

    private _interpolateNavigationSample(samples: RecorderNavigationSample[], playbackTimeMs: number): RecorderNavigationSample {
        if (samples.length === 1) return samples[0];
        if (playbackTimeMs <= 0) return samples[0];
        if (playbackTimeMs >= (samples[samples.length - 1]?.at || 0)) return samples[samples.length - 1];

        let previous = samples[0];
        let next = samples[samples.length - 1];
        for (let index = 1; index < samples.length; index += 1) {
            if (samples[index].at >= playbackTimeMs) {
                next = samples[index];
                previous = samples[index - 1];
                break;
            }
        }

        const span = Math.max(0.0001, next.at - previous.at);
        const localProgress = Math.min(1, Math.max(0, (playbackTimeMs - previous.at) / span));

        return {
            at: playbackTimeMs,
            rotation: this._interpolateNumber(previous.rotation, next.rotation, localProgress),
            zoomLevel: this._interpolateNumber(previous.zoomLevel, next.zoomLevel, localProgress),
            point: this._interpolatePoint(previous.point, next.point, localProgress),
            bounds: this._interpolateRect(previous.bounds, next.bounds, localProgress),
        };
    }

    private _applyNavigationSample(viewer: RecorderManagedViewer, sample: RecorderNavigationSample): void {
        if (typeof sample.rotation === "number" && !Number.isNaN(sample.rotation)) {
            viewer.viewport.setRotation(sample.rotation, true);
        }
        if (sample.bounds) {
            viewer.viewport.fitBounds(sample.bounds, true);
            return;
        }

        if (sample.point) {
            viewer.viewport.panTo(sample.point, true);
        }
        if (typeof sample.zoomLevel === "number" && !Number.isNaN(sample.zoomLevel)) {
            viewer.viewport.zoomTo(sample.zoomLevel, undefined, true);
        }
    }

    private _interpolateNumber(left: number | undefined, right: number | undefined, progress: number): number | undefined {
        if (typeof left !== "number") return right;
        if (typeof right !== "number") return left;
        return left + (right - left) * progress;
    }

    private _interpolatePoint(
        left: OpenSeadragon.Point | undefined,
        right: OpenSeadragon.Point | undefined,
        progress: number,
    ): OpenSeadragon.Point | undefined {
        if (!left) return right;
        if (!right) return left;
        return new OpenSeadragon.Point(
            left.x + (right.x - left.x) * progress,
            left.y + (right.y - left.y) * progress,
        );
    }

    private _interpolateRect(
        left: OpenSeadragon.Rect | undefined,
        right: OpenSeadragon.Rect | undefined,
        progress: number,
    ): OpenSeadragon.Rect | undefined {
        if (!left) return right;
        if (!right) return left;
        return new OpenSeadragon.Rect(
            left.x + (right.x - left.x) * progress,
            left.y + (right.y - left.y) * progress,
            left.width + (right.width - left.width) * progress,
            left.height + (right.height - left.height) * progress,
        );
    }

    private _equalCache(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
        if ((!a || !b) && a !== b) return false;
        if (!a || !b) return false;

        const leftKeys = Object.keys(a);
        const rightKeys = Object.keys(b);
        if (leftKeys.length !== rightKeys.length) return false;

        for (const key of leftKeys) {
            const leftValue = a[key];
            const rightValue = b[key];

            if (
                leftValue &&
                rightValue &&
                typeof leftValue === "object" &&
                typeof rightValue === "object" &&
                !Array.isArray(leftValue) &&
                !Array.isArray(rightValue)
            ) {
                if (!this._equalCache(leftValue as Record<string, unknown>, rightValue as Record<string, unknown>)) {
                    return false;
                }
                continue;
            }

            if (leftValue !== rightValue) {
                return false;
            }
        }

        return true;
    }

    private _equalOrder(left: string[] | undefined, right: string[] | undefined): boolean {
        if (!left || !right || left.length !== right.length) return false;
        return left.every((value, index) => value === right[index]);
    }
}

window.OpenSeadragon.Recorder = Recorder as typeof OpenSeadragon.Recorder;
addModule("recorder", Recorder);
