// LEGAL REVIEW REQUIRED before first commercial transaction — stub copy below is
// engineering-level only; controller identity, retention periods, NPC complaint procedure,
// and data-subject rights wording must be reviewed by counsel and approved by the Data
// Protection Officer per NPC Circular 16-01. Filed alongside NPC registration;
// see docs/roadmap.md Phase 4 prerequisites.
// Static RSC — no auth required. Reachable from the consent checkbox before authentication
// so clients can read the notice during order creation and from unauthenticated marketing surfaces. (ref: DL-006)
// Data-subject rights (access, rectification, erasure, withdrawal) are exercised via manual email
// to the controller at the address below — self-service deletion is not available. (ref: DL-007)
// Consent revocation/withdrawal mechanics (RA 10173 §34 prospective revocation) are not implemented;
// this page establishes write-once consent at order creation only. (ref: DL-013)
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Privacy Notice — PipetGo',
  description: 'How PipetGo collects, uses, and protects your personal information under RA 10173.',
}

export default function PrivacyPage() {
  return (
    <main className="max-w-3xl mx-auto px-4 py-12 text-gray-800">
      <h1 className="text-3xl font-bold mb-2">Privacy Notice</h1>
      <p className="text-sm text-gray-500 mb-8">Last updated: May 2026</p>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">1. Who We Are</h2>
        <p>
          PipetGo is a laboratory testing marketplace operated in the Philippines. We act as the
          personal information controller for data collected through this platform. Our contact
          address for privacy matters is{' '}
          <a href="mailto:privacy@pipetgo.com" className="underline text-green-700">
            privacy@pipetgo.com
          </a>
          .
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">2. What We Collect</h2>
        <p className="mb-2">
          When you submit a test request, we collect the following personal information:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Full name</li>
          <li>Email address</li>
          <li>Phone number</li>
          <li>Organization or institution name (optional)</li>
          <li>Shipping address (optional)</li>
        </ul>
        <p className="mt-2">
          Certain service categories — specifically chemical testing and biological testing — may
          involve samples that constitute sensitive personal information under National Privacy
          Commission (NPC) guidelines. We handle these with additional care.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">3. Why We Collect It</h2>
        <p>
          We collect your personal information to fulfil your testing request: to communicate
          with you about your order, to coordinate sample delivery with the laboratory, and to
          issue receipts and invoices. We do not sell your personal information to third parties.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">4. Legal Basis</h2>
        <p>
          We process your personal information on the basis of your explicit consent, given at
          the time you submit a test request. This consent is recorded with a timestamp as
          required by Republic Act No. 10173 (Data Privacy Act of the Philippines).
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">5. How Long We Keep It</h2>
        <p>
          We retain your personal information for as long as necessary to fulfil the purposes
          described in this notice and to comply with legal obligations. Order records are
          typically retained for five years from the date of the transaction.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">6. Your Rights</h2>
        <p className="mb-2">
          Under RA 10173, you have the right to:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>Be informed about how your data is used</li>
          <li>Access the personal information we hold about you</li>
          <li>Correct inaccurate or incomplete information</li>
          <li>Request erasure of your personal information</li>
          <li>Object to or withdraw consent for further processing</li>
        </ul>
        <p className="mt-2">
          To exercise any of these rights, email us at{' '}
          <a href="mailto:privacy@pipetgo.com" className="underline text-green-700">
            privacy@pipetgo.com
          </a>
          . We will respond within 15 days. Data deletion requests are handled manually at
          this stage; self-service deletion will be available in a future release.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-2">7. Contact</h2>
        <p>
          For questions about this notice or our data practices, contact our Data Privacy
          Officer at{' '}
          <a href="mailto:privacy@pipetgo.com" className="underline text-green-700">
            privacy@pipetgo.com
          </a>
          .
        </p>
      </section>

      <p className="text-xs text-gray-400 mt-12">
        This notice is a stub for the initial PR and is subject to legal review before
        PipetGo accepts its first commercial transaction.
      </p>
    </main>
  )
}
