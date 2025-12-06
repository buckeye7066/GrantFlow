import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Users, Mail, Calendar, Shield, Loader2, Trash2, AlertTriangle, Activity } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

export default function UserManagement() {
  const [deleteDialog, setDeleteDialog] = useState(null);
  const [expandedUser, setExpandedUser] = useState(null);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['allUsers'],
    queryFn: async () => {
      const response = await base44.functions.invoke('getUserList');
      const payload = response?.data || {};

      return {
        success: payload.success ?? false,
        error: payload.error ?? null,
        users: payload.users ?? [],
        count: payload.count ?? (payload.users?.length || 0)
      };
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (userId) => {
      const response = await base44.functions.invoke('deleteUser', { userId });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['allUsers'] });
      setDeleteDialog(null);
    }
  });

  if (isLoading) {
    return (
      <div className="min-h-screen p-6 bg-gradient-to-br from-slate-50 via-blue-50 to-purple-50">
        <div className="max-w-6xl mx-auto space-y-4 animate-pulse">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-24 bg-white rounded-xl shadow-sm" />
          ))}
        </div>
      </div>
    );
  }

  if (error || !data?.success) {
    return (
      <div className="min-h-screen p-6 bg-gradient-to-br from-slate-50 via-blue-50 to-purple-50">
        <div className="max-w-4xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800">Error loading users: {error?.message || data?.error}</p>
          </div>
        </div>
      </div>
    );
  }

  const users = data.users || [];

  return (
    <div className="min-h-screen p-6 bg-gradient-to-br from-slate-50 via-blue-50 to-purple-50">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
            <Users className="w-8 h-8 text-blue-600" />
            User Management
          </h1>
          <p className="text-slate-600 mt-1">Total authenticated users: {data.count}</p>
        </div>

        <div className="grid gap-4">
          {(Array.isArray(users) ? users : []).map((user) => (
            <Card key={user.id} className="hover:shadow-2xl hover:-translate-y-1 transition-all rounded-xl backdrop-blur-xl bg-white/80 border border-white/40">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center shadow-lg">
                      <span className="text-white font-semibold text-sm">
                        {user.full_name?.charAt(0)?.toUpperCase() || 'U'}
                      </span>
                    </div>
                    <div>
                      <CardTitle>{user.full_name || 'Unknown User'}</CardTitle>
                      <p className="text-sm text-slate-500">{user.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge 
                      className={`shadow-md ring-1 ring-white/20 ${
                        user.role === 'admin' 
                          ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white' 
                          : 'bg-slate-500 text-white'
                      }`}
                    >
                      <Shield className="w-3 h-3 mr-1" />
                      {user.role || 'user'}
                    </Badge>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteDialog(user)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex gap-6 text-sm text-slate-600">
                    <div className="flex items-center gap-2">
                      <Mail className="w-4 h-4" />
                      {user.email}
                    </div>
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4" />
                      Joined: {user.created_date ? new Date(user.created_date).toLocaleDateString() : "Unknown"}
                    </div>
                  </div>
                  
                  {user.activity && (
                    <>
                      <div className="flex gap-4 text-sm flex-wrap">
                        <Badge variant="outline">
                          <Activity className="w-3 h-3 mr-1" />
                          {user.activity?.total_actions ?? 0} actions
                        </Badge>
                        <Badge variant="outline">
                          {user.activity?.organizations ?? 0} organizations
                        </Badge>
                        <Badge variant="outline">
                          {user.activity?.grants ?? 0} grants
                        </Badge>
                        <Badge variant="outline">
                          {user.activity?.documents ?? 0} documents
                        </Badge>
                        <Badge variant="outline">
                          {user.activity?.budgets ?? 0} budgets
                        </Badge>
                        <Badge variant="outline">
                          {user.activity?.contacts ?? 0} contacts
                        </Badge>
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setExpandedUser(expandedUser === user.id ? null : user.id)}
                      >
                        {expandedUser === user.id ? 'Hide' : 'Show'} Activity Logs
                      </Button>

                      {expandedUser === user.id && (user.activity?.all_logs ?? []).length > 0 && (
                        <div className="mt-2 p-3 bg-white/60 backdrop-blur-lg rounded-lg border max-h-96 overflow-y-auto">
                          <h4 className="font-semibold text-sm mb-2">All Activity ({(user.activity?.all_logs ?? []).length} logs):</h4>
                          <div className="space-y-1 text-xs">
                            {(user.activity?.all_logs ?? []).map((log, idx) => (
                              <div key={idx} className="p-2 bg-white rounded border border-slate-200">
                                <div className="flex items-center justify-between">
                                  <div className="font-medium">{log.action} {log.type}</div>
                                  <Badge variant="secondary" className="text-xs">{log.type}</Badge>
                                </div>
                                <div className="text-slate-700 mt-1">{log.name}</div>
                                <div className="text-slate-500 text-xs mt-1">
                                  {new Date(log.date).toLocaleString()}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {expandedUser === user.id && (user.activity?.all_logs ?? []).length === 0 && (
                        <div className="mt-2 p-3 bg-white/60 backdrop-blur-lg rounded-lg border">
                          <p className="text-slate-500 text-sm">No activity logs</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {users.length === 0 && (
          <Card className="backdrop-blur-xl bg-white/80 border border-white/40 rounded-xl">
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500">No users found</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteDialog} onOpenChange={(open) => !open && setDeleteDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              Delete User
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this user? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          
          {deleteDialog && (
            <div className="my-4 p-4 bg-slate-50 rounded-lg">
              <p className="font-semibold">{deleteDialog.full_name}</p>
              <p className="text-sm text-slate-600">{deleteDialog.email}</p>
              {deleteDialog.activity && (
                <div className="mt-2 text-sm text-slate-600">
                  <p>Activity: {deleteDialog.activity?.total_actions ?? 0} total actions - {deleteDialog.activity?.organizations ?? 0} orgs, {deleteDialog.activity?.grants ?? 0} grants, {deleteDialog.activity?.documents ?? 0} docs</p>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteDialog && deleteMutation.mutate(deleteDialog.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete User
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}