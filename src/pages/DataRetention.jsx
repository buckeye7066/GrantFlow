export default function DataRetention() {
  return (
    <div className="min-h-screen bg-gray-50 py-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white rounded-lg shadow-md p-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-8">Data Retention Policy</h1>
          <p className="text-sm text-gray-600 mb-8">Last Updated: December 26, 2024</p>

          <div className="prose max-w-none">
            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Overview</h2>
              <p className="text-gray-700 mb-4">
                This Data Retention Policy outlines how Axiom BioLabs collects, stores, and deletes data through
                the GrantFlow service. We are committed to retaining your data only as long as necessary to provide
                our services and comply with legal obligations.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">1. Types of Data We Retain</h2>
              <p className="text-gray-700 mb-4">
                We retain the following categories of data:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li><strong>Account Information:</strong> Name, email, organization details, contact information</li>
                <li><strong>Application Data:</strong> Grant searches, application tracking records, saved preferences</li>
                <li><strong>Usage Data:</strong> Service usage metrics, feature utilization, system logs</li>
                <li><strong>Financial Data:</strong> Billing history, payment information (tokenized)</li>
                <li><strong>Technical Data:</strong> IP addresses, browser information, device identifiers</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">2. Retention Periods</h2>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">Active Accounts</h3>
              <p className="text-gray-700 mb-4">
                Data associated with active accounts is retained for the duration of the account's active status
                and for the periods specified below after account closure or cancellation.
              </p>
              
              <h3 className="text-xl font-semibold text-gray-900 mb-2">Account Data</h3>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Active account information: Retained while account is active</li>
                <li>Closed account information: 90 days after account closure</li>
                <li>Financial records: 7 years from last transaction (legal requirement)</li>
              </ul>

              <h3 className="text-xl font-semibold text-gray-900 mb-2">Application and Search Data</h3>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Grant search history: Retained while account is active plus 90 days</li>
                <li>Application tracking data: Retained while account is active plus 90 days</li>
                <li>Saved searches and preferences: Retained while account is active plus 30 days</li>
              </ul>

              <h3 className="text-xl font-semibold text-gray-900 mb-2">System and Security Logs</h3>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Security logs: 1 year</li>
                <li>Access logs: 90 days</li>
                <li>System performance logs: 30 days</li>
              </ul>

              <h3 className="text-xl font-semibold text-gray-900 mb-2">Backup Data</h3>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Regular backups: 30 days</li>
                <li>Archived backups: 1 year</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">3. Data Deletion Process</h2>
              <p className="text-gray-700 mb-4">
                When data reaches the end of its retention period, we follow a secure deletion process:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Data is permanently deleted from production systems</li>
                <li>Backup copies are securely overwritten or destroyed</li>
                <li>Encrypted data keys are destroyed, rendering data unrecoverable</li>
                <li>Deletion is verified through audit procedures</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">4. User-Initiated Deletion</h2>
              <p className="text-gray-700 mb-4">
                Users can request deletion of their data at any time by:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Closing their account through the service interface</li>
                <li>Contacting our support team at support@axiombiolabs.org</li>
                <li>Submitting a formal deletion request</li>
              </ul>
              <p className="text-gray-700 mb-4">
                Upon receiving a deletion request, we will:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Process the request within 30 days</li>
                <li>Delete all personal data except what must be retained for legal compliance</li>
                <li>Provide confirmation of deletion</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">5. Legal and Compliance Retention</h2>
              <p className="text-gray-700 mb-4">
                Certain data must be retained longer to comply with legal and regulatory requirements:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Tax and financial records: 7 years</li>
                <li>Data subject to legal hold or investigation: Duration of hold/investigation</li>
                <li>Records required by applicable healthcare regulations: As specified by law</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">6. Third-Party Data Processors</h2>
              <p className="text-gray-700 mb-4">
                We require all third-party service providers to:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Follow data retention practices consistent with this policy</li>
                <li>Delete or return data upon termination of services</li>
                <li>Provide documentation of data deletion upon request</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">7. Data Portability</h2>
              <p className="text-gray-700 mb-4">
                Before data deletion, users may request:
              </p>
              <ul className="list-disc pl-6 mb-4 text-gray-700">
                <li>Export of their account data in machine-readable format</li>
                <li>Copy of their application and search history</li>
                <li>Documentation of their usage data</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">8. Policy Updates</h2>
              <p className="text-gray-700 mb-4">
                This policy may be updated periodically to reflect changes in legal requirements or business practices.
                Material changes will be communicated to users via email and posted on this page.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Contact Information</h2>
              <p className="text-gray-700 mb-4">
                For questions about this Data Retention Policy or to request data deletion, contact:
              </p>
              <p className="text-gray-700">
                Email: privacy@axiombiolabs.org<br />
                Axiom BioLabs<br />
                Attn: Data Privacy Officer
              </p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
