import { Link } from 'react-router-dom';

export default function Navigation() {
  return (
    <nav className="bg-white shadow-md sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center">
            <Link to="/" className="flex items-center">
              <span className="text-2xl font-bold text-axiom-blue">GrantFlow</span>
            </Link>
          </div>
          <div className="hidden md:flex items-center space-x-8">
            <Link to="/" className="text-gray-700 hover:text-axiom-blue transition">
              Home
            </Link>
            <Link to="/pricing" className="text-gray-700 hover:text-axiom-blue transition">
              Pricing
            </Link>
            <a href="#features" className="text-gray-700 hover:text-axiom-blue transition">
              Features
            </a>
            <a href="#contact" className="text-gray-700 hover:text-axiom-blue transition">
              Contact
            </a>
            <Link
              to="/pricing"
              className="bg-axiom-blue text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition"
            >
              Get Started
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
