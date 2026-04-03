## History API

`APPLICATION_CONTEXT.history` is asynchronous and queue-based.

### Core methods

- `push(forward, backward, meta?)`
    - Executes `forward()` immediately.
    - Records the step only if `forward()` succeeds.

- `pushExecuted(forward, backward, meta?)`
    - Records an already-applied change without executing `forward()`.

- `undo()` / `redo()`
    - Return `Promise<boolean>`.
    - Resolve to `true` when a step was applied, otherwise `false`.

- `clear(options?)`
    - Clears committed stack history.
    - `options.resetProviders` also resets transient provider state.

- `withoutRecording(fn)`
    - Runs `fn` without recording nested history steps.

### Provider API

Providers can intercept undo/redo for transient state.

```ts
class MyProvider extends XOpatHistory.XOpatHistoryProvider {
    get importance() { return 10; }
    async undo() { /* ... */ return true; }
    async redo() { /* ... */ return true; }
    canUndo() { return true; }
    canRedo() { return false; }
    async reset() { /* optional */ }
}

const unregister = APPLICATION_CONTEXT.history.registerProvider(new MyProvider());