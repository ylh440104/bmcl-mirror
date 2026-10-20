export class Semaphore {
  constructor (size) {
    this.size = Math.max(1, size)
    this.active = 0
    this.queue = []
  }

  async acquire () {
    if (this.active < this.size) {
      this.active += 1
      return
    }
    await new Promise(resolve => this.queue.push(resolve))
    this.active += 1
  }

  release () {
    this.active -= 1
    const next = this.queue.shift()
    if (next) next()
  }

  async run (fn) {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}