export default function HIPAA() {
  return (
    <div className="min-h-screen bg-gray-50 py-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white rounded-lg shadow-md p-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-8">HIPAA Compliance</h1>
          <p className="text-sm text-gray-600 mb-8">Last Updated: December 26, 2024</p>

          <div className="prose max-w-none">
            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Our Commitment to HIPAA Compliance</h2>
              <p className="text-gray-700 mb-4">
                Axiom BioLabs is committed to protecting the privacy and security of Protected Health Information (PHI)
                in accordance with the Health Insurance Portability and Accountability Act (HIPAA) and its implementing
                regulations.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">1. Business Associate Agreement</h2>
              <p className="text-gray-700 mb-4">
                For Enterprise clients handling PHI, we enter into a Business Associate Agreement (BAA) that outlines
                our responsibilities under HIPAA. This agreement ensures that:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>We implement appropriate safeguards to protect PHI</li>
                <li>We report any security incidents or breaches</li>
                <li>We ensure our subcontractors are also HIPAA compliant</li>
                <li>We make PHI available to individuals as required</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">2. Administrative Safeguards</h2>
              <p className="text-gray-700 mb-4">
                We maintain comprehensive administrative safeguards including:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Security Management Process with risk analysis and management</li>
                <li>Workforce security policies and procedures</li>
                <li>Information access management controls</li>
                <li>Security awareness and training programs</li>
                <li>Incident response and reporting procedures</li>
                <li>Contingency planning for emergencies</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">3. Physical Safeguards</h2>
              <p className="text-gray-700 mb-4">
                Our physical security measures include:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Secure data centers with restricted access</li>
                <li>Facility access controls and visitor management</li>
                <li>Workstation security protocols</li>
                <li>Device and media controls</li>
                <li>Environmental controls and monitoring</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">4. Technical Safeguards</h2>
              <p className="text-gray-700 mb-4">
                We implement robust technical safeguards:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Access controls with unique user identification</li>
                <li>Encryption of PHI in transit and at rest using industry standards (AES-256)</li>
                <li>Audit controls and logging of system activity</li>
                <li>Automatic logoff and session timeout mechanisms</li>
                <li>Integrity controls to ensure PHI is not improperly altered</li>
                <li>Regular security patches and updates</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">5. Breach Notification</h2>
              <p className="text-gray-700 mb-4">
                In the event of a breach of unsecured PHI, we will:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Notify affected covered entities without unreasonable delay and no later than 60 days</li>
                <li>Provide detailed information about the breach</li>
                <li>Cooperate fully with covered entities in their notification obligations</li>
                <li>Document all breach incidents and responses</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">6. Employee Training</h2>
              <p className="text-gray-700 mb-4">
                All employees with access to PHI undergo:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Initial HIPAA compliance training</li>
                <li>Annual refresher training</li>
                <li>Role-specific security training</li>
                <li>Training on new policies and procedures</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">7. Audit and Compliance</h2>
              <p className="text-gray-700 mb-4">
                We conduct regular audits to ensure ongoing compliance:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Annual third-party security assessments</li>
                <li>Regular internal audits of access logs and security controls</li>
                <li>Penetration testing and vulnerability assessments</li>
                <li>Review and update of policies and procedures</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">8. Subcontractor Management</h2>
              <p className="text-gray-700 mb-4">
                All subcontractors who may have access to PHI are required to:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Enter into Business Associate Agreements</li>
                <li>Demonstrate HIPAA compliance</li>
                <li>Implement appropriate safeguards</li>
                <li>Submit to security assessments</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Contact for HIPAA Matters</h2>
              <p className="text-gray-700 mb-4">
                For questions regarding our HIPAA compliance or to request a Business Associate Agreement, please contact:
              </p>
              <p className="text-gray-700">
                Email: compliance@axiombiolabs.org<br />
                Axiom BioLabs<br />
                Attn: HIPAA Privacy Officer
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
