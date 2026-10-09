import type { StateStore } from 'oidc-client-ts'

const PREFIX = 'janeway-admin.oidc.'
const STATE_TTL = 10 * 60 * 1000

// Only authorization transactions (PKCE verifier, state, nonce) cross a redirect.
// Tokens and user profiles use MemoryUserStore below, never this store.
export class TransactionStore implements StateStore {
  constructor(private readonly storage: Storage, private readonly now = Date.now) {}

  async set(key: string, value: string): Promise<void> {
    this.storage.setItem(PREFIX + key, JSON.stringify({ value, createdAt: this.now() }))
  }

  async get(key: string): Promise<string | null> {
    const raw = this.storage.getItem(PREFIX + key)
    if (!raw) return null
    try {
      const entry = JSON.parse(raw)
      const age = this.now() - entry.createdAt
      if (typeof entry.value === 'string' && Number.isFinite(age) && age >= 0 && age < STATE_TTL) return entry.value
    } catch { /* A corrupt transaction is not a recoverable sign-in. */ }
    this.storage.removeItem(PREFIX + key)
    return null
  }

  async remove(key: string): Promise<string | null> {
    // get() reads synchronously; remove before yielding to competing callbacks.
    const value = this.get(key)
    this.storage.removeItem(PREFIX + key)
    return value
  }

  async getAllKeys(): Promise<string[]> {
    const keys: string[] = []
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index)
      if (key?.startsWith(PREFIX)) keys.push(key.slice(PREFIX.length))
    }
    return keys
  }

  async clear(): Promise<void> {
    for (const key of await this.getAllKeys()) this.storage.removeItem(PREFIX + key)
  }
}

// Sealing is synchronous: a late callback/refresh cannot repopulate cleared memory.
export class MemoryUserStore implements StateStore {
  private readonly values = new Map<string, string>()
  private sealed = false

  async set(key: string, value: string): Promise<void> {
    if (!this.sealed) this.values.set(key, value)
  }
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null }
  async remove(key: string): Promise<string | null> {
    const value = this.values.get(key) ?? null
    this.values.delete(key)
    return value
  }
  async getAllKeys(): Promise<string[]> { return [...this.values.keys()] }
  seal(): void { this.sealed = true; this.values.clear() }
}
