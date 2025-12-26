import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div>
            <h3 className="text-xl font-bold mb-4">GrantFlow</h3>
            <p className="text-gray-400 text-sm">
              Powered by Axiom BioLabs - Finding funding sources for various financial situations.
            </p>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2">
              <li>
                <a href="#features" className="text-gray-400 hover:text-white transition text-sm">
                  Features
                </a>
              </li>
              <li>
                <Link to="/pricing" className="text-gray-400 hover:text-white transition text-sm">
                  Pricing
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Legal</h4>
            <ul className="space-y-2">
              <li>
                <Link to="/terms" className="text-gray-400 hover:text-white transition text-sm">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link to="/privacy" className="text-gray-400 hover:text-white transition text-sm">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link to="/hipaa" className="text-gray-400 hover:text-white transition text-sm">
                  HIPAA Compliance
                </Link>
              </li>
              <li>
                <Link to="/data-retention" className="text-gray-400 hover:text-white transition text-sm">
                  Data Retention
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold mb-4">Contact</h4>
            <ul className="space-y-2">
              <li className="text-gray-400 text-sm">
                Axiom BioLabs
              </li>
              <li className="text-gray-400 text-sm">
                support@axiombiolabs.org
              </li>
            </ul>
          </div>
        </div>
        <div className="border-t border-gray-800 mt-8 pt-8 text-center text-gray-400 text-sm">
          <p>&copy; {new Date().getFullYear()} Axiom BioLabs. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
