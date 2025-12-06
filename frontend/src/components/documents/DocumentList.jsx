import React from "react";
import { CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FolderOpen, UploadCloud } from "lucide-react";
import DocumentItem from "./DocumentItem";
import { SkeletonDocumentCard } from "@/components/shared/SkeletonCard";

/**
 * Document list component that handles rendering of documents with loading and empty states
 * @param {Object} props
 * @param {Array} props.documents - Array of document objects
 * @param {boolean} props.isLoading - Loading state
 * @param {Object} props.selectedOrg - Selected organization object
 * @param {Function} props.onDelete - Callback when document is deleted
 * @param {Function} props.onUpload - Callback to show upload form
 */
export default function DocumentList({ documents, isLoading, selectedOrg, onDelete, onUpload }) {
  // Normalize documents to array; tolerate null/undefined
  const list = Array.isArray(documents) ? documents : [];
  const safeOnUpload = typeof onUpload === 'function' ? onUpload : () => {};
  const safeOnDelete = typeof onDelete === 'function' ? onDelete : () => {};

  if (isLoading) {
    return (
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, index) => (
            <SkeletonDocumentCard key={`skel-${index}`} />
          ))}
        </div>
      </CardContent>
    );
  }

  if (list.length === 0) {
    return (
      <CardContent>
        <div className="text-center py-16 text-slate-500" aria-live="polite">
          <FolderOpen className="w-16 h-16 mx-auto mb-4 text-slate-300" />
          <h3 className="text-xl font-semibold text-slate-900 mb-2">No Documents Yet</h3>
          {!selectedOrg ? (
            <p>Please select an organization to view or add documents.</p>
          ) : (
            <>
              <p className="mb-4">Get started by uploading your first document for {selectedOrg.name || 'this profile'}.</p>
              <Button onClick={safeOnUpload}>
                <UploadCloud className="w-4 h-4 mr-2" />
                Upload First Document
              </Button>
            </>
          )}
        </div>
      </CardContent>
    );
  }

  return (
    <CardContent>
      <div 
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
        role="list"
        aria-label="Document list"
      >
        {list.map((doc, idx) => (
          <DocumentItem 
            key={doc?.id ? `doc-${String(doc.id)}` : `doc-idx-${idx}`} 
            document={doc} 
            onDelete={safeOnDelete}
          />
        ))}
      </div>
    </CardContent>
  );
}