import type { AdminConfig } from './config'
import type { OwnerSession } from './api'

export interface DeviceProof {
  version: 2
  poolId: string
  clientId: string
  username: string
  sub: string
  loginId: string
  deviceKey: string
  deviceGroupKey: string
  randomPasswordKey: string
}

type LegacyDeviceProof = Omit<DeviceProof, 'version'> & { version: 1; expiresAt: string }
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048
const fields = ['version', 'poolId', 'clientId', 'username', 'sub', 'loginId', 'deviceKey', 'deviceGroupKey', 'randomPasswordKey']
const MAX_SESSION_SECONDS = 8 * 60 * 60
const MAX_CHECKPOINT_BYTES = 64 * 1024
const sessionKeys = ['accessToken', 'idToken', 'refreshToken', 'deviceKey', 'deviceGroupKey', 'randomPasswordKey', 'clockDrift'] as const
interface TabSession {
  version: 1
  poolId: string
  clientId: string
  authTime: number
  expiresAt: number
  values: Record<string, string>
}

// Amplify's public KeyValueStorage interface stays memory-first. Settled SDK
// sessions are explicitly checkpointed to this tab; only opted-in device proof
// is copied to localStorage. Neither store receives arbitrary SDK writes.
export class DeviceStorage {
  private readonly values = new Map<string, string>()
  private sealed = false
  private revocationToken: string | null = null
  readonly recordKey: string
  private readonly prefix: string
  readonly sessionKey: string
  private authTime: number | null = null

  constructor(
    private readonly config: AdminConfig,
    private readonly persistent: Storage | null,
    private readonly tab: Storage | null = null,
    private readonly now = () => Math.floor(Date.now() / 1000),
  ) {
    this.prefix = `CognitoIdentityServiceProvider.${config.clientId}.`
    this.recordKey = `janeway-admin.device.${config.poolId}.${config.clientId}`
    this.sessionKey = `janeway-admin.session.${config.poolId}.${config.clientId}`
  }

  async getItem(key: string): Promise<string | null> { return this.sealed ? null : this.values.get(key) ?? null }
  async setItem(key: string, value: string): Promise<void> {
    if (this.sealed) return
    this.values.set(key, value)
  }
  async removeItem(key: string): Promise<void> { this.values.delete(key) }
  async clear(): Promise<void> { this.values.clear() }

  seal(forSignOut = false, preserveCheckpoint = false): void {
    if (!this.sealed && forSignOut) {
      const username = this.values.get(`${this.prefix}LastAuthUser`)
      this.revocationToken = username ? this.values.get(`${this.prefix}${username}.refreshToken`) ?? null : null
    }
    this.sealed = true
    this.values.clear()
    if (!preserveCheckpoint) this.discardCheckpoint()
  }

  takeRevocationToken(): string | null {
    const token = this.revocationToken
    this.revocationToken = null
    return token
  }

  private discardCheckpoint(): void {
    try { this.tab?.removeItem(this.sessionKey) } catch { /* Storage may be unavailable. */ }
  }

  private validTime(authTime: number): boolean {
    return Number.isSafeInteger(authTime) && authTime > 0 && authTime <= this.now() + 60 &&
      authTime + MAX_SESSION_SECONDS > this.now()
  }

  private validValues(values: Record<string, string>): boolean {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return false
    const username = values[`${this.prefix}LastAuthUser`]
    if (!bounded(username)) return false
    const allowed = [`${this.prefix}LastAuthUser`, ...sessionKeys.map(key => `${this.prefix}${username}.${key}`)]
    if (!Object.entries(values).every(([key, value]) => allowed.includes(key) && typeof value === 'string' && value.length > 0)) return false
    return ['accessToken', 'refreshToken', 'deviceKey', 'deviceGroupKey', 'randomPasswordKey'].every(key =>
      !!values[`${this.prefix}${username}.${key}`])
  }

  restore(): boolean {
    if (this.sealed) return false
    try {
      const raw = this.tab?.getItem(this.sessionKey)
      if (!raw) return false
      if (new TextEncoder().encode(raw).byteLength > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint is too large')
      const record = JSON.parse(raw) as TabSession
      if (!record || Object.keys(record).length !== 6 ||
        !['version', 'poolId', 'clientId', 'authTime', 'expiresAt', 'values'].every(key => Object.hasOwn(record, key)) ||
        record.version !== 1 || record.poolId !== this.config.poolId || record.clientId !== this.config.clientId ||
        !this.validTime(record.authTime) || record.expiresAt !== record.authTime + MAX_SESSION_SECONDS ||
        !this.validValues(record.values)) throw new Error('Invalid checkpoint')
      this.values.clear()
      for (const [key, value] of Object.entries(record.values)) this.values.set(key, value)
      this.authTime = record.authTime
      return true
    } catch {
      this.values.clear()
      this.discardCheckpoint()
      return false
    }
  }

  checkpoint(authTime: number): void {
    if (this.sealed) return
    if (!this.validTime(authTime) || (this.authTime !== null && this.authTime !== authTime)) {
      this.discardCheckpoint()
      throw new Error('Authentication lifetime changed or expired')
    }
    this.authTime = authTime
    if (!this.tab) return
    const username = this.values.get(`${this.prefix}LastAuthUser`)
    const values: Record<string, string> = {}
    for (const key of [`${this.prefix}LastAuthUser`, ...sessionKeys.map(key => `${this.prefix}${username}.${key}`)]) {
      const value = this.values.get(key)
      if (value !== undefined) values[key] = value
    }
    if (!this.validValues(values)) {
      this.discardCheckpoint()
      throw new Error('Incomplete authentication checkpoint')
    }
    const raw = JSON.stringify({
      version: 1, poolId: this.config.poolId, clientId: this.config.clientId,
      authTime, expiresAt: authTime + MAX_SESSION_SECONDS, values,
    } satisfies TabSession)
    try {
      if (new TextEncoder().encode(raw).byteLength > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint is too large')
      this.tab.setItem(this.sessionKey, raw)
    } catch { this.discardCheckpoint() /* Unavailable tab storage must not prevent an in-memory login. */ }
  }

  saved(): DeviceProof | null {
    try {
      const raw = this.persistent?.getItem(this.recordKey)
      if (!raw) return null
      const value = JSON.parse(raw) as DeviceProof | LegacyDeviceProof
      const expectedFields = value.version === 1 ? [...fields, 'expiresAt'] : fields
      if (
        (value.version === 1 || value.version === 2) &&
        Object.keys(value).length === expectedFields.length && expectedFields.every(field => Object.hasOwn(value, field)) &&
        value.poolId === this.config.poolId && value.clientId === this.config.clientId &&
        [value.username, value.sub, value.loginId, value.deviceKey, value.deviceGroupKey, value.randomPasswordKey].every(bounded) &&
        (value.version === 2 || (typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) &&
          new Date(value.expiresAt).toISOString() === value.expiresAt))
      ) {
        if (value.version === 2) return value
        // One-time migration of the deployed 30-day browser record. Server-side
        // Cognito existence/recovery checks remain authoritative after migration.
        const migrated: DeviceProof = {
          version: 2, poolId: value.poolId, clientId: value.clientId,
          username: value.username, sub: value.sub, loginId: value.loginId,
          deviceKey: value.deviceKey, deviceGroupKey: value.deviceGroupKey,
          randomPasswordKey: value.randomPasswordKey,
        }
        this.persistent?.setItem(this.recordKey, JSON.stringify(migrated))
        return migrated
      }
      this.forget()
    } catch { this.forget() }
    return null
  }

  hydrate(loginId: string): void {
    if (this.sealed) throw new Error('Authentication storage is closed')
    this.values.clear()
    this.authTime = null
    this.discardCheckpoint()
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
    const proof: DeviceProof = {
      version: 2, poolId: this.config.poolId, clientId: this.config.clientId,
      username, sub: session.owner.sub, loginId, deviceKey: session.device.key,
      deviceGroupKey: this.values.get(`${this.prefix}${username}.deviceGroupKey`)!,
      randomPasswordKey: this.values.get(`${this.prefix}${username}.randomPasswordKey`)!,
    }
    this.persistent.setItem(this.recordKey, JSON.stringify(proof))
  }

  forget(): void {
    try { this.persistent?.removeItem(this.recordKey) } catch { /* The server still rejects revoked/deleted proof. */ }
  }
}
