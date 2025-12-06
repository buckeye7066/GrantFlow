import React from "react";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { FileText, Plus, Upload } from "lucide-react";

/**
 * Action buttons for organization management
 * @param {Object} props
 * @param {Function} props.onQuickAdd - Callback for quick add
 * @param {Function} props.onUpload - Callback for upload form
 * @param {Function} props.onNewApplication - Callback for new application
 */
export default function OrganizationActions({ onQuickAdd, onUpload, onNewApplication }) {
  return (
    <div className="flex gap-3 flex-wrap">
      <Link to={createPageUrl('PrintableApplication')}>
        <Button
          variant="outline"
          className="border-purple-600 text-purple-600 hover:bg-purple-50"
          aria-label="Print blank application form"
        >
          <FileText className="w-4 h-4 mr-2" />
          Print Blank Form
        </Button>
      </Link>
      <Button
        onClick={onUpload}
        variant="outline"
        className="border-green-600 text-green-600 hover:bg-green-50"
        aria-label="Upload completed form"
      >
        <Upload className="w-4 h-4 mr-2" />
        Upload Completed Form
      </Button>
      <Button
        onClick={onQuickAdd}
        variant="outline"
        className="border-blue-600 text-blue-600 hover:bg-blue-50"
        aria-label="Quick add profile"
      >
        <Plus className="w-4 h-4 mr-2" />
        Quick Add
      </Button>
      <Button
        onClick={onNewApplication}
        className="bg-blue-600 hover:bg-blue-700"
        aria-label="Create new application"
      >
        <FileText className="w-4 h-4 mr-2" />
        New Application
      </Button>
    </div>
  );
}