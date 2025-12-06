import React, { Suspense } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { 
  Sparkles, 
  Search, 
  FileText, 
  TrendingUp, 
  CheckCircle,
  ArrowRight,
  Clock
} from 'lucide-react';
import BotConversation from '@/components/landing/BotConversation';
import FloatingParticles from '@/components/landing/FloatingParticles';

export default function Landing() {
  const applicationUrl = 'https://grantflow.app';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-purple-50 relative">
      <FloatingParticles />
      
      {/* Hero Section */}
      <section aria-label="Hero Section" className="container mx-auto px-6 py-16 md:py-24">
        <div className="text-center max-w-4xl mx-auto mb-16">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="inline-flex items-center gap-2 bg-purple-100 text-purple-700 px-4 py-2 rounded-full mb-6"
          >
            <Sparkles className="w-4 h-4" />
            <span className="text-sm font-medium">AI-Powered Grant Writing Platform</span>
          </motion.div>
          
          <motion.h1 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-5xl md:text-6xl font-bold mb-6 bg-gradient-to-r from-blue-600 via-purple-500 to-pink-500 bg-clip-text text-transparent animate-gradient-x"
          >
            Welcome to GrantFlow
          </motion.h1>
          
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="text-xl text-slate-600 mb-8 leading-relaxed"
          >
            Your intelligent partner in discovering, managing, and winning grant funding. 
            GrantFlow uses advanced AI to match your organization with the perfect funding opportunities 
            and guides you through every step of the application process.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
          >
            <Button 
              size="lg" 
              className="bg-blue-600 hover:bg-blue-700 text-lg px-8 py-6"
              onClick={() => window.open(applicationUrl, '_blank')}
              aria-label="Begin GrantFlow application"
            >
              Apply Now
              <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
          </motion.div>
        </div>

        {/* How It Works */}
        <section aria-label="How It Works" className="grid md:grid-cols-3 gap-8 mb-16">
          <motion.div 
            whileHover={{ scale: 1.05, rotateY: 6 }} 
            transition={{ type: 'spring', stiffness: 150 }}
          >
            <Card className="border-2 hover:border-blue-300 transition-all h-full">
              <CardHeader>
                <motion.div 
                  whileHover={{ rotateX: 10, rotateY: -10 }}
                  className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-4"
                >
                  <Search className="w-6 h-6 text-blue-600" aria-hidden="true" />
                </motion.div>
                <CardTitle>Discover Opportunities</CardTitle>
                <CardDescription>
                  AI-powered search finds grants perfectly matched to your organization's mission and needs
                </CardDescription>
              </CardHeader>
            </Card>
          </motion.div>

          <motion.div 
            whileHover={{ scale: 1.05, rotateY: 6 }} 
            transition={{ type: 'spring', stiffness: 150 }}
          >
            <Card className="border-2 hover:border-purple-300 transition-all h-full">
              <CardHeader>
                <motion.div 
                  whileHover={{ rotateX: 10, rotateY: -10 }}
                  className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-4"
                >
                  <FileText className="w-6 h-6 text-purple-600" aria-hidden="true" />
                </motion.div>
                <CardTitle>Smart Application Assistant</CardTitle>
                <CardDescription>
                  Guided proposal writing with AI suggestions, templates, and real-time compliance checking
                </CardDescription>
              </CardHeader>
            </Card>
          </motion.div>

          <motion.div 
            whileHover={{ scale: 1.05, rotateY: 6 }} 
            transition={{ type: 'spring', stiffness: 150 }}
          >
            <Card className="border-2 hover:border-green-300 transition-all h-full">
              <CardHeader>
                <motion.div 
                  whileHover={{ rotateX: 10, rotateY: -10 }}
                  className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mb-4"
                >
                  <TrendingUp className="w-6 h-6 text-green-600" aria-hidden="true" />
                </motion.div>
                <CardTitle>Track & Manage</CardTitle>
                <CardDescription>
                  Pipeline management, deadline tracking, and stewardship tools to maximize your success
                </CardDescription>
              </CardHeader>
            </Card>
          </motion.div>
        </section>

        {/* Bot Conversation */}
        <section aria-label="Interactive Demo" className="mb-16">
          <Suspense fallback={<div className="text-center text-slate-500 py-8">Loading interactive demo…</div>}>
            <BotConversation />
          </Suspense>
        </section>

        {/* Application Process */}
        <section aria-label="Getting Started">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <Card className="max-w-3xl mx-auto bg-white/80 backdrop-blur-sm border-2">
              <CardHeader>
                <CardTitle className="text-2xl flex items-center gap-2">
                  <Clock className="w-6 h-6 text-blue-600" aria-hidden="true" />
                  Getting Started
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div key="step1" className="flex items-start gap-4">
                  <div className="w-8 h-8 bg-blue-600 text-white rounded-full flex items-center justify-center flex-shrink-0 font-bold">
                    1
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900 mb-1">Submit Your Application</h3>
                    <p className="text-slate-600">
                      Click the "Apply Now" button to complete your profile application. 
                      Tell us about your organization and your funding needs.
                    </p>
                  </div>
                </div>

                <div key="step2" className="flex items-start gap-4">
                  <div className="w-8 h-8 bg-purple-600 text-white rounded-full flex items-center justify-center flex-shrink-0 font-bold">
                    2
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900 mb-1">Profile Review & Approval</h3>
                    <p className="text-slate-600">
                      Our team will review your application to ensure GrantFlow is the right fit. 
                      This typically takes 1-2 business days.
                    </p>
                  </div>
                </div>

                <div key="step3" className="flex items-start gap-4">
                  <div className="w-8 h-8 bg-green-600 text-white rounded-full flex items-center justify-center flex-shrink-0 font-bold">
                    3
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900 mb-1">Start Finding Funding</h3>
                    <p className="text-slate-600">
                      Once approved, your profile will be added to the GrantFlow program and you can 
                      immediately start discovering opportunities, drafting proposals, and managing your grants.
                    </p>
                  </div>
                </div>

                <div className="mt-8 pt-6 border-t border-slate-200">
                  <Button 
                    size="lg" 
                    className="w-full bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-700 hover:to-purple-700"
                    onClick={() => window.open(applicationUrl, '_blank')}
                    aria-label="Complete your GrantFlow application"
                  >
                    <CheckCircle className="w-5 h-5 mr-2" aria-hidden="true" />
                    Complete Your Application
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </section>

        {/* Features Highlight */}
        <section aria-label="Stats and Highlights" className="mt-16 text-center">
          <motion.h2 
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
            className="text-3xl font-bold text-slate-900 mb-8"
          >
            Trusted by Organizations Like Yours
          </motion.h2>
          <div className="grid md:grid-cols-4 gap-6 max-w-4xl mx-auto">
            {[
              { value: '$18M+', label: 'Grants Secured', color: 'text-blue-600' },
              { value: '500+', label: 'Organizations Served', color: 'text-purple-600' },
              { value: '85%', label: 'Success Rate', color: 'text-green-600' },
              { value: '10K+', label: 'Opportunities Matched', color: 'text-orange-600' },
            ].map((stat, idx) => (
              <motion.div 
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: idx * 0.1 }}
                viewport={{ once: true }}
                className="text-center"
              >
                <div className={`text-3xl font-bold ${stat.color} mb-2`}>{stat.value}</div>
                <div className="text-sm text-slate-600">{stat.label}</div>
              </motion.div>
            ))}
          </div>
        </section>
      </section>
    </div>
  );
}