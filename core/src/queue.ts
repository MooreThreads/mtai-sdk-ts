export class AsyncQueue<T> {
    private items: T[] = []
    private waitingDequeues: ((value: T) => void)[] = []
    private waitingEnqueues: (() => void)[] = []
    private maxSize: number

    constructor(maxSize: number = Infinity) {
        this.maxSize = maxSize
    }

    async enqueue(item: T): Promise<void> {
        if (this.waitingDequeues.length > 0) {
            const resolve = this.waitingDequeues.shift()!
            resolve(item)
            return
        }

        if (this.items.length >= this.maxSize) {
            await new Promise<void>((resolve) => {
                this.waitingEnqueues.push(resolve)
            })
        }

        this.items.push(item)
    }

    async dequeue(): Promise<T> {
        if (this.items.length > 0) {
            const item = this.items.shift()!
            if (this.waitingEnqueues.length > 0) {
                const resolve = this.waitingEnqueues.shift()!
                resolve()
            }
            return item
        }

        return new Promise<T>((resolve) => {
            this.waitingDequeues.push(resolve)
        })
    }

    get length(): number {
        return this.items.length
    }

    get isEmpty(): boolean {
        return this.items.length === 0
    }

    get isFull(): boolean {
        return this.items.length >= this.maxSize
    }
}
