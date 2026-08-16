/**
 * Where an AI provider's API key actually lives (spec §13, Rafa's guardrail
 * #1: "Keys via callable into Secret Manager... client never sees key
 * material"). Two implementations behind one interface, exactly mirroring
 * `functions/src/mail/index.ts`'s `getMailTransport()` swap-point pattern:
 *
 *   - `FirestoreDevSecretStore` — the default returned by `getSecretStore()`
 *     today. There is no Secret Manager emulator in the Firebase emulator
 *     suite, and this app must never reach out to a REAL GCP project from
 *     local/emulator dev (same rule as "never touch the real Leah/ERP
 *     Firestore project," CLAUDE.md). Stores the raw key in
 *     `_devSecrets/{name}` — a collection `firestore.rules` denies to every
 *     client unconditionally, same as `auditLog`. The security property the
 *     guardrail actually cares about (the CLIENT never sees key material)
 *     still holds: only this server-side module ever reads `_devSecrets`,
 *     and no callable response ever includes a key. What does NOT hold in
 *     dev is "encrypted at rest via Secret Manager specifically" — that's
 *     real only once `GcpSecretManagerStore` is swapped in below.
 *   - `GcpSecretManagerStore` — the real implementation, ready to deploy.
 *     Swap the constructor in `getSecretStore()` for this at deploy time
 *     (added to the deploy checklist alongside the VAPID key and the real
 *     mail transport).
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager'

import { COLLECTIONS, db } from '../firebase'

export interface SecretStore {
  /** Stores `value` under `name`, returning an opaque ref `read()` can resolve later. Overwrites any existing value for the same `name` — a key "Replace" is a new version, not a new secret identity. */
  store(name: string, value: string): Promise<string>
  read(secretRef: string): Promise<string>
}

export class FirestoreDevSecretStore implements SecretStore {
  async store(name: string, value: string): Promise<string> {
    await db.collection(COLLECTIONS.devSecrets).doc(name).set({ value, updatedAt: new Date() })
    return name
  }

  async read(secretRef: string): Promise<string> {
    const snap = await db.collection(COLLECTIONS.devSecrets).doc(secretRef).get()
    const value = snap.get('value') as string | undefined
    if (!value) throw new Error(`Dev secret store: no value stored for "${secretRef}".`)
    return value
  }
}

/** Real Secret Manager. Not exercised by any test in this codebase — there is nothing to test without a real GCP project and real credentials. */
export class GcpSecretManagerStore implements SecretStore {
  private readonly client = new SecretManagerServiceClient()

  private projectId(): string {
    const id = process.env.GCLOUD_PROJECT ?? process.env.GCP_PROJECT
    if (!id) throw new Error('GcpSecretManagerStore: no GCLOUD_PROJECT in the environment.')
    return id
  }

  async store(name: string, value: string): Promise<string> {
    const parent = `projects/${this.projectId()}`
    const secretName = `${parent}/secrets/${name}`
    try {
      await this.client.getSecret({ name: secretName })
    } catch {
      await this.client.createSecret({
        parent,
        secretId: name,
        secret: { replication: { automatic: {} } },
      })
    }
    const [version] = await this.client.addSecretVersion({
      parent: secretName,
      payload: { data: Buffer.from(value, 'utf8') },
    })
    if (!version.name) throw new Error('GcpSecretManagerStore: addSecretVersion returned no version name.')
    return version.name
  }

  async read(secretRef: string): Promise<string> {
    const [accessed] = await this.client.accessSecretVersion({ name: secretRef })
    const data = accessed.payload?.data
    if (!data) throw new Error(`GcpSecretManagerStore: no payload for "${secretRef}".`)
    return typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
  }
}

let store: SecretStore | null = null

/** The active secret store — the Firestore dev stub today; swap the implementation constructed here for GcpSecretManagerStore at deploy time. */
export function getSecretStore(): SecretStore {
  if (!store) store = new FirestoreDevSecretStore()
  return store
}
