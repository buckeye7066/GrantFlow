import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="bg-gradient-to-r from-blue-600 to-blue-800 text-white py-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h1 className="text-5xl md:text-6xl font-bold mb-6">
              Find Funding Sources with GrantFlow
            </h1>
            <p className="text-xl md:text-2xl mb-8 text-blue-100">
              Streamline your grant search and application process with AI-powered matching
            </p>
            <div className="flex flex-col sm:flex-row justify-center gap-4">
              <Link
                to="/pricing"
                className="bg-white text-blue-700 px-8 py-4 rounded-lg text-lg font-semibold hover:bg-blue-50 transition"
              >
                Get Started
              </Link>
              <a
                href="#features"
                className="bg-blue-700 text-white px-8 py-4 rounded-lg text-lg font-semibold hover:bg-blue-600 transition border-2 border-white"
              >
                Learn More
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20 bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold text-gray-900 mb-4">
              Powerful Features for Grant Seekers
            </h2>
            <p className="text-xl text-gray-600">
              Everything you need to find and secure funding for your projects
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="bg-white p-8 rounded-lg shadow-md">
              <div className="text-blue-600 text-4xl mb-4">🔍</div>
              <h3 className="text-2xl font-bold mb-4">Smart Search</h3>
              <p className="text-gray-600">
                AI-powered grant matching that connects you with the most relevant funding opportunities
                based on your profile and needs.
              </p>
            </div>
            <div className="bg-white p-8 rounded-lg shadow-md">
              <div className="text-blue-600 text-4xl mb-4">📊</div>
              <h3 className="text-2xl font-bold mb-4">Application Tracking</h3>
              <p className="text-gray-600">
                Keep track of all your grant applications in one place with automated reminders and
                status updates.
              </p>
            </div>
            <div className="bg-white p-8 rounded-lg shadow-md">
              <div className="text-blue-600 text-4xl mb-4">🔒</div>
              <h3 className="text-2xl font-bold mb-4">Secure & Compliant</h3>
              <p className="text-gray-600">
                HIPAA-compliant data handling with enterprise-grade security to protect your sensitive
                information.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-4xl font-bold text-gray-900 mb-6">
                Why Choose GrantFlow?
              </h2>
              <ul className="space-y-4">
                <li className="flex items-start">
                  <span className="text-blue-600 mr-2">✓</span>
                  <span className="text-gray-700">
                    <strong>Comprehensive Database:</strong> Access thousands of grant opportunities
                    updated daily
                  </span>
                </li>
                <li className="flex items-start">
                  <span className="text-blue-600 mr-2">✓</span>
                  <span className="text-gray-700">
                    <strong>Time-Saving:</strong> Reduce research time by up to 70% with our AI matching
                    algorithm
                  </span>
                </li>
                <li className="flex items-start">
                  <span className="text-blue-600 mr-2">✓</span>
                  <span className="text-gray-700">
                    <strong>Expert Support:</strong> Dedicated support team to help you every step of the way
                  </span>
                </li>
                <li className="flex items-start">
                  <span className="text-blue-600 mr-2">✓</span>
                  <span className="text-gray-700">
                    <strong>Success Tracking:</strong> Monitor your application success rate and optimize
                    your strategy
                  </span>
                </li>
              </ul>
            </div>
            <div className="bg-blue-50 p-8 rounded-lg">
              <p className="text-gray-700 italic text-lg mb-4">
                "GrantFlow has transformed how we find and apply for grants. We've secured 3x more funding
                since switching to this platform."
              </p>
              <p className="font-semibold text-gray-900">- Healthcare Organization</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section id="contact" className="bg-blue-600 text-white py-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-4xl font-bold mb-6">
            Ready to Find Your Next Grant?
          </h2>
          <p className="text-xl mb-8 text-blue-100">
            Join thousands of organizations that have successfully secured funding with GrantFlow
          </p>
          <Link
            to="/pricing"
            className="inline-block bg-white text-blue-700 px-8 py-4 rounded-lg text-lg font-semibold hover:bg-blue-50 transition"
          >
            Start Your Free Trial
          </Link>
          <p className="mt-4 text-blue-100">No credit card required</p>
        </div>
      </section>
    </div>
  );
}
