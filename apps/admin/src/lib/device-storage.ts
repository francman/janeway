import type { AdminConfig } from './config'
import type { OwnerSession } from './api'

export interface DeviceProof {
  version: 1
  poolId: string
  clientId: string
  username: string
  sub: string
  loginId: string
  deviceKey: string
  deviceGroupKey: string
  randomPasswordKey: string
  expiresAt: string
}

const DEVICE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048

// Amplify's public KeyValueStorage interface. SDK keys are memory-only: persistence
// is an explicit, allowlisted copy of confirmed device proof, never a write-through.
export class DeviceStorage {
  private readonly values = new Map<string, string>()
  private sealed = false
  private revocationToken: string | null = null
  private captureRevocation = false
  readonly recordKey: string
  private readonly prefix: string

  constructor(private readonly config: AdminConfig, private readonly persistent: Storage | null, private readonly now = Date.now) {
    this.prefix = `CognitoIdentityServiceProvider.${config.clientId}.`
    this.recordKey = `janeway-admin.device.${config.poolId}.${config.clientId}`
  }

  async getItem(key: string): Promise<string | null> { return this.sealed ? null : this.values.get(key) ?? null }
  async setItem(key: string, value: string): Promise<void> {
    if (this.sealed) {
      // Only a logout already in progress may collect a late rotating token for
      // revocation. This cell is never readable by Auth or written to storage.
      if (this.captureRevocation && key.startsWith(this.prefix) && key.endsWith('.refreshToken')) this.revocationToken = value
      return
    }
    this.values.set(key, value)
  }
  async removeItem(key: string): Promise<void> { this.values.delete(key) }
  async clear(): Promise<void> { this.values.clear() }

  seal(forSignOut = false): void {
    if (!this.sealed && forSignOut) {
      const username = this.values.get(`${this.prefix}LastAuthUser`)
      this.revocationToken = username ? this.values.get(`${this.prefix}${username}.refreshToken`) ?? null : null
      this.captureRevocation = true
    }
    this.sealed = true
    this.values.clear()
  }

  takeRevocationToken(): string | null {
    const token = this.revocationToken
    this.revocationToken = null
    this.captureRevocation = false
    return token
  }

  saved(): DeviceProof | null {
    try {
      const raw = this.persistent?.getItem(this.recordKey)
      if (!raw) return null
      const value = JSON.parse(raw) as DeviceProof
      const expiry = Date.parse(value.expiresAt)
      if (
        value.version === 1 && value.poolId === this.config.poolId && value.clientId === this.config.clientId &&
        [value.username, value.sub, value.loginId, value.deviceKey, value.deviceGroupKey, value.randomPasswordKey].every(bounded) &&
        Number.isFinite(expiry) && expiry > this.now() && expiry <= this.now() + DEVICE_LIFETIME_MS &&
        new Date(expiry).toISOString() === value.expiresAt
      ) return value
      this.forget()
    } catch { this.forget() }
    return null
  }

  hydrate(loginId: string): void {
    if (this.sealed) throw new Error('Authentication storage is closed')
    this.values.clear()
    const proof = this.saved()
    if (!proof || (proof.loginId !== loginId && proof.username !== loginId)) return
    // SRP first looks up the submitted identifier, then the canonical username
    // from USER_ID_FOR_SRP. Neither alias carries any saved session tokens.
    for (const username of new Set([proof.username, proof.loginId])) {
      for (const key of ['deviceKey', 'deviceGroupKey', 'randomPasswordKey'] as const) {
        this.values.set(`${this.prefix}${username}.${key}`, proof[key])
      }
    }
  }

  confirmed(username: string, deviceKey: string): boolean {
    if (this.sealed || this.values.get(`${this.prefix}LastAuthUser`) !== username) return false
    return this.values.get(`${this.prefix}${username}.deviceKey`) === deviceKey &&
      !!this.values.get(`${this.prefix}${username}.deviceGroupKey`) && !!this.values.get(`${this.prefix}${username}.randomPasswordKey`)
  }

  isSaved(username: string, sub: string, deviceKey: string): boolean {
    const proof = this.saved()
    return !!proof && proof.username === username && proof.sub === sub && proof.deviceKey === deviceKey
  }

  promote(username: string, loginId: string, session: OwnerSession): void {
    if (!this.confirmed(username, session.device.key) || !this.persistent) throw new Error('Device proof cannot be saved')
    const previous = this.saved()
    // A repeated sign-in cannot restart the server's creation-based lifetime.
    const expiresAt = previous?.deviceKey === session.device.key && Date.parse(previous.expiresAt) < Date.parse(session.device.expiresAt)
      ? previous.expiresAt : session.device.expiresAt
    if (Date.parse(expiresAt) <= this.now()) throw new Error('Device proof has expired')
    const proof: DeviceProof = {
      version: 1, poolId: this.config.poolId, clientId: this.config.clientId,
      username, sub: session.owner.sub, loginId, deviceKey: session.device.key,
      deviceGroupKey: this.values.get(`${this.prefix}${username}.deviceGroupKey`)!,
      randomPasswordKey: this.values.get(`${this.prefix}${username}.randomPasswordKey`)!, expiresAt,
    }
    this.persistent.setItem(this.recordKey, JSON.stringify(proof))
  }

  forget(): void {
    try { this.persistent?.removeItem(this.recordKey) } catch { /* The server still rejects revoked/expired proof. */ }
  }
}
