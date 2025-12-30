import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FolderOpen, Loader2, Building2, UploadCloud } from "lucide-react";
import DocumentUploader from "../components/documents/DocumentUploader";
import DocumentItem from "../components/documents/DocumentItem";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function Documents() {
  const [showUploader, setShowUploader] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  const [deletingDoc, setDeletingDoc] = useState(null);
  const queryClient = useQueryClient();

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    onSuccess: (data) => {
      if (data.length > 0 && !selectedOrgId) {
        setSelectedOrgId(data[0].id);
      }
    }
  });

  const { data: documents = [], isLoading: isLoadingDocuments } = useQuery({
    queryKey: ['documents', selectedOrgId],
    queryFn: () => base44.entities.Document.filter({ organization_id: selectedOrgId }),
    enabled: !!selectedOrgId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Document.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents', selectedOrgId] });
      setDeletingDoc(null);
    },
  });

  const handleDelete = (doc) => {
    setDeletingDoc(doc);
  };

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Document Library</h1>
            <p className="text-slate-600 mt-2">Upload, organize, and manage all your grant-related documents.</p>
          </div>
          <div className="flex gap-4 items-center">
            {organizations.length > 0 && (
              <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
                <SelectTrigger className="w-64">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-slate-500" />
                    <SelectValue placeholder="Select an Organization..." />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {organizations.map(org => (
                    <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              onClick={() => setShowUploader(true)}
              disabled={!selectedOrgId}
              className="bg-blue-600 hover:bg-blue-700"
            >
              <UploadCloud className="w-4 h-4 mr-2" />
              Upload Document
            </Button>
          </div>
        </div>

        {showUploader && (
          <DocumentUploader
            organizationId={selectedOrgId}
            onClose={() => setShowUploader(false)}
          />
        )}

        <Card className="shadow-lg border-0">
          <CardHeader>
            <CardTitle>
              {organizations.find(o => o.id === selectedOrgId)?.name || 'All'} Documents ({documents.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoadingDocuments ? (
              <div className="flex justify-center items-center py-16">
                <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
              </div>
            ) : documents.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <FolderOpen className="w-16 h-16 mx-auto mb-4 text-slate-300" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">No Documents Yet</h3>
                {!selectedOrgId ? (
                  <p>Please select an organization to view or add documents.</p>
                ) : (
                  <>
                    <p className="mb-4">Get started by uploading your first document for this profile.</p>
                    <Button onClick={() => setShowUploader(true)}>
                      <UploadCloud className="w-4 h-4 mr-2" />
                      Upload First Document
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {documents.map(doc => (
                  <DocumentItem key={doc.id} document={doc} onDelete={handleDelete} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={!!deletingDoc} onOpenChange={() => setDeletingDoc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the document "{deletingDoc?.title}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingDoc && deleteMutation.mutate(deletingDoc.id)}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}