/**
 * Policy library data access — `policies/{policyId}` (spec §12, Phase 4).
 *
 * Versioned + immutable: `createPolicyVersion` always writes a brand-new
 * document (never updates an existing one's content) and, when superseding
 * an existing family, flips the OLD current version's `isCurrent` to false —
 * the ONE field firestore.rules allows mutating on an otherwise-immutable
 * doc. A signature binds to the exact `version` it was signed against
 * (`src/lib/hr/hrActions.ts`), so old signatures stay meaningful forever
 * even after a newer version ships.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { Policy, PolicyCategory } from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'

function policyDoc(id: string) {
  return doc(db, COLLECTIONS.policies, id)
}

function toPolicy(snap: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>): Policy {
  const d = snap.data() ?? {}
  return {
    id: snap.id,
    familyId: String(d.familyId ?? snap.id),
    title: String(d.title ?? ''),
    titleEs: String(d.titleEs ?? ''),
    bodyMarkdown: String(d.bodyMarkdown ?? ''),
    bodyMarkdownEs: String(d.bodyMarkdownEs ?? ''),
    version: Number(d.version ?? 1),
    category: (d.category as PolicyCategory) ?? 'other',
    requiresSignature: Boolean(d.requiresSignature),
    activeFrom: String(d.activeFrom ?? ''),
    isCurrent: Boolean(d.isCurrent),
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/** Every policy version ever created — the Library screen filters to current/archived itself. */
export async function listPolicies(): Promise<Policy[]> {
  try {
    const snap = await getDocs(collection(db, COLLECTIONS.policies))
    return snap.docs.map(toPolicy).sort((a, b) => a.title.localeCompare(b.title) || b.version - a.version)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

/** Only the CURRENT version of every policy family — what a staff member needs to read/sign, and what "N haven't signed" is computed against. */
export async function listCurrentPolicies(): Promise<Policy[]> {
  try {
    const snap = await getDocs(query(collection(db, COLLECTIONS.policies), where('isCurrent', '==', true)))
    return snap.docs.map(toPolicy).sort((a, b) => a.title.localeCompare(b.title))
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

export async function getPolicy(id: string): Promise<Policy | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(policyDoc(id))
    return snap.exists() ? toPolicy(snap) : null
  })
}

export interface NewPolicyFamilyInput {
  title: string
  titleEs: string
  bodyMarkdown: string
  bodyMarkdownEs: string
  category: PolicyCategory
  requiresSignature: boolean
  activeFrom: string
  locationId?: string | null
}

/** Creates a brand-new policy family (version 1). */
export async function createPolicyFamily(input: NewPolicyFamilyInput): Promise<Policy> {
  const ref = doc(collection(db, COLLECTIONS.policies))
  const payload = {
    familyId: ref.id,
    title: input.title,
    titleEs: input.titleEs,
    bodyMarkdown: input.bodyMarkdown,
    bodyMarkdownEs: input.bodyMarkdownEs,
    version: 1,
    category: input.category,
    requiresSignature: input.requiresSignature,
    activeFrom: input.activeFrom,
    isCurrent: true,
    locationId: input.locationId ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, payload)
  return { id: ref.id, ...payload }
}

export interface NewPolicyVersionInput {
  title: string
  titleEs: string
  bodyMarkdown: string
  bodyMarkdownEs: string
  category: PolicyCategory
  requiresSignature: boolean
  activeFrom: string
  locationId?: string | null
}

/**
 * Supersedes `previous` with a new version in the SAME family — creates a
 * new document (version + 1) and flips `previous.isCurrent` to false. This
 * is what "editing a policy" means end to end: the old text/version is never
 * touched, and any signature already recorded against it stays valid for
 * that exact version forever. Resurfaces the signature requirement
 * automatically — anyone who signed the old version now shows as not
 * having signed the new `isCurrent` one.
 */
export async function createPolicyVersion(previous: Policy, input: NewPolicyVersionInput): Promise<Policy> {
  const ref = doc(collection(db, COLLECTIONS.policies))
  const payload = {
    familyId: previous.familyId,
    title: input.title,
    titleEs: input.titleEs,
    bodyMarkdown: input.bodyMarkdown,
    bodyMarkdownEs: input.bodyMarkdownEs,
    version: previous.version + 1,
    category: input.category,
    requiresSignature: input.requiresSignature,
    activeFrom: input.activeFrom,
    isCurrent: true,
    locationId: input.locationId ?? previous.locationId ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, payload)
  await updateDoc(policyDoc(previous.id), { isCurrent: false, updatedAt: serverTimestamp() })
  return { id: ref.id, ...payload }
}
