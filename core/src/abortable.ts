import { Abortable } from "./types"

/**
 * Creates an abortable object that allows registering and triggering abort handlers.
 * 
 * @returns An Abortable object with methods to abort and register abort handlers
 * 
 * @example
 * ```typescript
 * const controller = abortable();
 * 
 * // Register an abort handler
 * const unregister = controller.onabort(() => {
 *   console.log('Operation was aborted');
 * });
 * 
 * // Later, trigger all registered handlers
 * controller.abort();
 * 
 * // Or unregister a specific handler
 * unregister();
 * ```
 */

export function abortable(): Abortable {
    const handlers: Set<() => void> = new Set()
    let aborted = false
    const abort = () => {
        if (aborted) return
        aborted = true
        const invoking = [...handlers]
        handlers.clear()
        invoking.forEach(_ => _())
    }
    const onabort = (handler: () => void) => {
        if (aborted) handler()
        else handlers.add(handler)
        return () => {
            handlers.delete(handler)
        }
    }
    return {
        abort,
        onabort,
    }
}

export function child(parent: Abortable): [Abortable, () => void] {
    const child = abortable()
    return [child, parent.onabort(child.abort)]
}

export async function withChild<T>(parent: Abortable, f: (child: Abortable) => Promise<T>): Promise<T> {
    const [childAbortable, unregister] = child(parent)
    let aborted = false
    const unsubscribe = childAbortable.onabort(() => { aborted = true })
    try {
        if (aborted) throw new Error('connection aborted')
        return await f(childAbortable)
    } catch (e) {
        childAbortable.abort()
        throw e
    } finally {
        unsubscribe()
        unregister()
    }
}