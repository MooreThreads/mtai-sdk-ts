import { EventSource, EventTarget } from "./types"

/**
 * Creates an event system that allows subscribing to and emitting events.
 * 
 * @template T - A type mapping event names to event data types
 * @returns An object that implements both EventSource and EventTarget interfaces
 * 
 * @example
 * ```typescript
 * type MyEvents = {
 *   click: { x: number, y: number };
 *   load: boolean;
 * }
 * 
 * const myEvents = events<MyEvents>();
 * 
 * // Subscribe to events
 * const unsubscribe = myEvents.on('click', (data) => {
 *   console.log(`Clicked at ${data.x}, ${data.y}`);
 * });
 * 
 * // Emit events
 * myEvents.emit('click', { x: 10, y: 20 });
 * 
 * // Unsubscribe from events
 * unsubscribe();
 * // or
 * myEvents.off('click');
 * ```
 */
export function events<T>(): EventSource<T> & EventTarget<T> {
    const listeners = new Map<keyof T, ((_: any) => void)[]>()
    const on = (event: any, handler: (_: any) => void) => {
        listeners.set(event, [...(listeners.get(event) || []), handler])
        return () => off(event, handler)
    }
    const off = (event: any, handler?: (_: any) => void) => {
        if (handler) {
            listeners.set(event, listeners.get(event)?.filter(h => h !== handler) || [])
        } else {
            listeners.delete(event)
        }
    }
    const emit = (event: any, data: T[keyof T]) => {
        listeners.get(event)?.forEach(handler => handler(data))
    }
    return { on, off, emit }
}
