import type { SessionDetail } from './chat'

export type ResumeSession = SessionDetail & { acceptedResumeTurn: boolean }

/** Read the durable turn before replaying an ambiguous request. */
export async function deliverResume(actions: {
  send: () => Promise<void>
  inspect: () => Promise<ResumeSession>
  restore: (detail: ResumeSession) => void
}, retry: boolean) {
  async function reconcile() {
    const snapshot = await actions.inspect()
    actions.restore(snapshot)
    return snapshot.acceptedResumeTurn
  }
  if (retry && await reconcile()) return
  try {
    await actions.send()
  } catch (error) {
    if (!await reconcile()) throw error
  }
}
