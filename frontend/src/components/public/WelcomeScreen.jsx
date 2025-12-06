import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { FileText, Download, CheckCircle2, DollarSign, Clock, Shield } from 'lucide-react';

export default function WelcomeScreen({ onStart, onDownload }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 flex items-center justify-center p-6">
      <div className="max-w-4xl w-full space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-blue-600 rounded-full mb-4">
            <FileText className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-slate-900 mb-3">
            GrantFlow Application Portal
          </h1>
          <p className="text-xl text-slate-600">
            Professional Grant Writing & Application Support Services
          </p>
        </div>

        {/* Main Info Card */}
        <Card className="shadow-2xl">
          <CardContent className="p-8 space-y-6">
            <div>
              <h2 className="text-2xl font-bold text-slate-900 mb-4">Welcome to GrantFlow</h2>
              <p className="text-slate-700 leading-relaxed mb-4">
                GrantFlow provides professional assistance with grant application preparation, research, review, and submission support. 
                Whether you're an individual, student, family, nonprofit, or organization seeking funding, we help you navigate the 
                complex world of grant applications with expert guidance and comprehensive support.
              </p>
            </div>

            {/* Services Overview */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="font-semibold text-slate-900">Application Preparation</h3>
                  <p className="text-sm text-slate-600">Complete drafting and formatting of grant applications</p>
                </div>
              </div>
              <div className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="font-semibold text-slate-900">Research & Matching</h3>
                  <p className="text-sm text-slate-600">Identify the best funding opportunities for your needs</p>
                </div>
              </div>
              <div className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="font-semibold text-slate-900">Document Review</h3>
                  <p className="text-sm text-slate-600">Professional editing and compliance checking</p>
                </div>
              </div>
              <div className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="font-semibold text-slate-900">Submission Support</h3>
                  <p className="text-sm text-slate-600">Guidance through online portals and submission processes</p>
                </div>
              </div>
            </div>

            {/* How Billing Works */}
            <div className="bg-amber-50 rounded-lg p-6 border-2 border-amber-200">
              <div className="flex items-center gap-2 mb-3">
                <DollarSign className="w-6 h-6 text-amber-600" />
                <h3 className="text-lg font-bold text-slate-900">How Billing Works</h3>
              </div>
              <div className="space-y-2 text-sm text-slate-700">
                <div className="flex gap-2">
                  <Clock className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <p><strong>Monthly Billing:</strong> Services are billed monthly based on application type and complexity</p>
                </div>
                <div className="flex gap-2">
                  <FileText className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <p><strong>Weekly Invoices:</strong> You'll receive detailed invoices every Sunday showing work completed and progress</p>
                </div>
                <div className="flex gap-2">
                  <Shield className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <p><strong>Transparent Pricing:</strong> Costs are calculated based on the application types you select</p>
                </div>
              </div>
            </div>

            {/* Important Notice */}
            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <p className="text-sm text-slate-700">
                <strong className="text-blue-900">Important Notice:</strong> GrantFlow is a fee-based professional service. 
                While we provide expert assistance with applications, <strong>funding awards are not guaranteed</strong> and are 
                determined solely by the funding organizations.
              </p>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-4 pt-4">
              <Button
                onClick={onStart}
                className="flex-1 bg-blue-600 hover:bg-blue-700 h-14 text-lg"
                size="lg"
              >
                <FileText className="w-5 h-5 mr-2" />
                Begin Online Application
              </Button>
              <Button
                onClick={onDownload}
                variant="outline"
                className="flex-1 h-14 text-lg border-2"
                size="lg"
              >
                <Download className="w-5 h-5 mr-2" />
                Download Application (PDF)
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Footer */}
        <div className="text-center text-sm text-slate-600">
          <p>Created by <strong className="text-slate-900">Dr. John White</strong></p>
          <p className="mt-1">Questions? Email <strong>Dr.JohnWhite@axiombiolabs.org</strong></p>
        </div>
      </div>
    </div>
  );
}