import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Bell, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { toast as sonnerToast } from 'sonner';

export default function NotifyNewUser() {
  const [isChecking, setIsChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState(null);

  const checkNewUsers = async () => {
    setIsChecking(true);
    try {
      const response = await base44.functions.invoke('getUserList');
      
      const payload = response.data ?? response;
      if (!payload?.success && !payload?.users) {
        throw new Error(payload?.error || 'Failed to fetch users');
      }

      const users = Array.isArray(payload.users) ? payload.users : [];
      
      // Check for users created in last 24 hours who haven't been notified
      const recentUsers = users.filter(user => {
        const createdDate = new Date(
          user.created_date || user.created_at || user.createdDate
        );
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        return createdDate > dayAgo;
      });

      if (recentUsers.length > 0) {
        // Send notifications for recent users
        for (const user of recentUsers) {
          await base44.functions.invoke('notifyAdminNewUser', {
            userEmail: user.email,
            userName: user.full_name || user.email || 'New User'
          });
        }
        
        sonnerToast.success(`Sent ${recentUsers.length} user signup notifications`);
      } else {
        sonnerToast.info('No new users in the last 24 hours');
      }

      setLastCheck(new Date());
    } catch (error) {
      sonnerToast.error('Failed to check for new users');
      console.error(error);
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="w-6 h-6 text-blue-600" />
              User Signup Notifications
            </CardTitle>
            <CardDescription>
              Manually check for new user signups and send email notifications
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertCircle className="w-4 h-4" />
              <AlertDescription>
                This tool checks for users who signed up in the last 24 hours and sends
                email notifications to Dr. John White for each new signup.
              </AlertDescription>
            </Alert>

            <Button 
              onClick={checkNewUsers}
              disabled={isChecking}
              className="w-full"
            >
              {isChecking ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Checking for new users...
                </>
              ) : (
                <>
                  <Bell className="w-4 h-4 mr-2" />
                  Check & Notify New Users
                </>
              )}
            </Button>

            {lastCheck && (
              <Alert className="bg-green-50 border-green-200">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                <AlertDescription className="text-green-800">
                  Last checked: {lastCheck.toLocaleString()}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}